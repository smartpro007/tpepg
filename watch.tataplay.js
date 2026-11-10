const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const fs = require('fs');
const zlib = require('zlib');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runGenerator() {
  console.log('Starting Safe Rate-Limited Combined EPG Script...');
  
  let allChannelsDict = {}; 
  let reportDataDict = {};  
  let tataChannelCount = 0;
  let jioChannelCount = 0;

  const today = dayjs().tz('Asia/Kolkata');
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'), // Yesterday (-1)
    today.format('DD-MM-YYYY'),                   // Today (0)
    today.add(1, 'day').format('DD-MM-YYYY')       // Tomorrow (+1)
  ];

  // ==========================================
  // १. TATA PLAY EPG FETCHING (Safe Rate-Limited)
  // ==========================================
  console.log('\n=== STEP 1: Fetching TataPlay EPG (Safe Mode) ===');

  for (const dateStr of datesToFetch) {
    console.log(`\n--- Processing TataPlay Date: ${dateStr} ---`);
    let currentOffset = 0;
    const batchLimit = 20;
    let totalChannels = 836;
    let fetchedCount = 0;

    while (currentOffset < totalChannels) {
      console.log(`[TataPlay] Date: ${dateStr} | Offset: ${currentOffset} / ${totalChannels}`);
      
      let responseData = null;
      let attempts = 5; // प्रयत्न ५ वेळा वाढवले

      while (attempts > 0) {
        try {
          const url = `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=${dateStr}&languageFilters=&genreFilters=&limit=${batchLimit}&offset=${currentOffset}`;
          const resp = await axios.get(url, { headers: getTataHeaders(), timeout: 20000 });
          responseData = resp.data?.data;
          break;
        } catch (err) {
          attempts--;
          const status = err.response?.status;
          console.error(`[TataPlay Error] Offset ${currentOffset} failed (Status: ${status || err.message}). Retries left: ${attempts}`);
          
          if (status === 429) {
            console.log('--> Rate limit hit (429)! Cooling down for 30 seconds...');
            await sleep(30000); // 429 आल्यास ३० सेकंद पूर्ण थांबणे
          } else {
            await sleep(10000);
          }
        }
      }

      if (!responseData || !Array.isArray(responseData.channelList) || responseData.channelList.length === 0) {
        console.log(`[TataPlay] No data at offset ${currentOffset}, moving forward.`);
        currentOffset += batchLimit;
        await sleep(3000);
        continue;
      }

      totalChannels = responseData.total || totalChannels;
      const channels = responseData.channelList;

      channels.hash = channels.forEach(ch => {
        if (ch.title && ch.title !== '.') {
          const site_id = `tp_${String(ch.id)}`;
          const name = ch.title;
          const logo = ch.transparentImageUrl || ch.thumbnailImage || '';
          const items = ch.epg || [];

          if (!allChannelsDict[site_id]) {
            allChannelsDict[site_id] = { id: site_id, name: name, logo: logo, epgItems: [] };
            reportDataDict[site_id] = { id: site_id, name: name, provider: 'TataPlay', epg_generated: false };
            tataChannelCount++;
          }

          if (items.length > 0) {
            reportDataDict[site_id].epg_generated = true;
            items.forEach(item => {
              allChannelsDict[site_id].epgItems.push({ type: 'tataplay', data: item });
            });
          }
        }
      });

      currentOffset += batchLimit; 
      fetchedCount++;

      // प्रत्येक रिक्वेस्टनंतर ३ सेकंदाचा सुरक्षित गॅप (429 एरर टाळण्यासाठी)
      await sleep(3000); 
    }
  }

  console.log(`\n>>> TataPlay Fetch Completed! Total Unique Channels: ${tataChannelCount}`);

  // ==========================================
  // २. JIOTV EPG FETCHING
  // ==========================================
  console.log('\n=== STEP 2: Fetching JioTV EPG (20-Channel Batches) ===');

  if (fs.existsSync('./jiotv.json')) {
    const fileContent = fs.readFileSync('./jiotv.json', 'utf-8');
    const parsedJson = JSON.parse(fileContent);
    const jioChannels = parsedJson.channels || [];

    console.log(`Found ${jioChannels.length} JioTV channels in jiotv.json to process.`);
    const offsets = [-1, 0, 1];
    const chunk = 20;

    for (let i = 0; i < jioChannels.length; i += chunk) {
      const batchChannels = jioChannels.slice(i, i + chunk);
      console.log(`Processing JioTV Batch ${Math.floor(i / chunk) + 1} of ${Math.ceil(jioChannels.length / chunk)}...`);

      await Promise.all(batchChannels.map(async (jioCh) => {
        const jioId = String(jioCh.channel_id || jioCh.id);
        const jioName = jioCh.channel_name || jioCh.name;

        if (!allChannelsDict[jioId]) {
          allChannelsDict[jioId] = { id: jioId, name: jioName, logo: jioCh.logo || '', epgItems: [] };
          reportDataDict[jioId] = { id: jioId, name: jioName, provider: 'JioTV', epg_generated: false };
          jioChannelCount++;
        }

        for (const off of offsets) {
          try {
            const resp = await axios.get(`https://iptvmax.site/api/epg/epg.php?id=${jioId}&offset=${off}`, { timeout: 10000 });
            const data = resp.data;
            const programs = Array.isArray(data) ? data : (data.epg || []);

            if (programs.length > 0) {
              reportDataDict[jioId].epg_generated = true;
              programs.forEach(prog => {
                allChannelsDict[jioId].epgItems.push({ type: 'jiotv', data: prog });
              });
            }
          } catch (e) {
            // Ignore error
          }
        }
      }));

      await sleep(500);
    }
  } else {
    console.log('--> jiotv.json file not found! Skipping JioTV.');
  }

  console.log(`\n>>> JioTV Fetch Completed! Total Unique Channels: ${jioChannelCount}`);

  // ==========================================
  // ३. XML असेंब्ली व रिटेन्शन विंडो
  // ==========================================
  console.log('\n=== STEP 3: Assembling XML & Saving Files ===');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Clean-Combined-EPG">\n';

  const now = dayjs();
  const maxPastTime = now.subtract(8, 'day'); 
  const maxFutureTime = now.add(2, 'day');    

  Object.values(allChannelsDict).forEach(ch => {
    xml += `  <channel id="${ch.id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  Object.values(allChannelsDict).forEach(ch => {
    ch.epgItems.forEach(item => {
      let startTime, endTime, title, desc, icon;

      if (item.type === 'tataplay') {
        const epg = item.data;
        startTime = dayjs(Number(epg.startTime));
        endTime = dayjs(Number(epg.endTime));
        title = epg.title || '';
        desc = epg.desc || '';
        icon = epg.boxCoverImage || '';
      } else if (item.type === 'jiotv') {
        const prog = item.data;
        startTime = dayjs(Number(prog.startEpoch));
        endTime = dayjs(Number(prog.endEpoch));
        title = prog.showname || '';
        desc = prog.description || '';
        icon = prog.assets?.['16:9']?.originalProgram || '';
      }

      if (startTime && startTime.isValid() && endTime && endTime.isValid()) {
        if (endTime.isAfter(maxPastTime) && startTime.isBefore(maxFutureTime)) {
          const startStr = startTime.format('YYYYMMDDHHmmss ZZ');
          const stopStr = endTime.format('YYYYMMDDHHmmss ZZ');

          xml += `  <programme start="${startStr}" stop="${stopStr}" channel="${ch.id}">\n`;
          xml += `    <title lang="en">${escapeXML(title)}</title>\n`;
          if (desc) {
            xml += `    <desc lang="en">${escapeXML(desc)}</desc>\n`;
          }
          if (icon) {
            xml += `    <icon src="${escapeXML(icon)}" />\n`;
          }
          xml += `  </programme>\n`;
        }
      }
    });
  });

  xml += '</tv>';

  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  fs.writeFileSync('./epg/tataplay.xml.gz', zlib.gzipSync(xml));
  
  const reportList = Object.values(reportDataDict);
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportList, null, 2), 'utf-8');

  console.log(`\n==================================================`);
  console.log(`SUMMARY REPORT:`);
  console.log(`- TataPlay Channels Processed: ${tataChannelCount}`);
  console.log(`- JioTV Channels Processed: ${jioChannelCount}`);
  console.log(`- Total Combined Channels: ${reportList.length}`);
  console.log(`SUCCESS! All files saved successfully.`);
  console.log(`==================================================`);
}

function escapeXML(str) {
  if (!str) return '';
  return String(str).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function getTataHeaders() {
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://watch.tataplay.com',
    'Referer': 'https://watch.tataplay.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'content-type': 'application/json',
    'locale': 'ENG',
    'me': 'web'
  };
}

runGenerator();
