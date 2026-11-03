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

async function generateEPG() {
  console.log('Starting 3-Day EPG Generation for ALL 836 Channels (No Error Mode)...');
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-3Days-Custom">\n';

  // ३ दिवसांची रेंज तयार करणे: मागील १ दिवस, आजचा दिवस, पुढील १ दिवस
  const today = dayjs().tz('Asia/Kolkata');
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'), // Yesterday
    today.format('DD-MM-YYYY'),                   // Today
    today.add(1, 'day').format('DD-MM-YYYY')       // Tomorrow
  ];

  console.log(`Target Dates: ${datesToFetch.join(', ')}`);

  let allChannelsDict = {}; // सर्व चॅनेल्सची युनिक यादी साठवण्यासाठी
  let reportDataDict = {};  // चॅनेल रिपोर्ट साठवण्यासाठी

  // १. प्रत्येक दिवसासाठी लूप चालवणे
  for (const dateStr of datesToFetch) {
    console.log(`\n==================================================`);
    console.log(`>>> Processing Date: ${dateStr}`);
    console.log(`==================================================`);

    let offset = 0;
    let limit = 20;
    let total = 836;
    let requestCount = 0;

    while (offset < total) {
      console.log(`[Date: ${dateStr}] Fetching channels offset ${offset} of ${total}...`);
      
      let responseData = null;
      let retries = 3;

      // एरर आला तर ३ वेळा रीट्राय करण्याचे सेफ लॉजिक
      while (retries > 0) {
        try {
          const resp = await axios.get(
            `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=${dateStr}&languageFilters=&genreFilters=&limit=${limit}&offset=${offset}`,
            { headers: setHeaders(), timeout: 15000 }
          );
          responseData = resp.data?.data;
          break; // यशस्वी झाल्यास व्हाईल लूपमधून बाहेर पडणे
        } catch (err) {
          retries--;
          console.error(`--> Error at offset ${offset} (Date: ${dateStr}). Status: ${err.response?.status || err.message}`);
          console.log(`--> Waiting 60 seconds for server cooldown before retrying... (Retries left: ${retries})`);
          await sleep(60000); // 429 एरर आल्यास १ पूर्ण मिनिट थांबणे
        }
      }

      if (!responseData || !responseData.channelList || responseData.channelList.length === 0) {
        console.log(`No channel data received for offset ${offset}. Moving to next offset.`);
        offset += limit;
        continue;
      }

      total = responseData.total || total;
      const channelList = responseData.channelList;

      channelList.forEach(channel => {
        if (channel.title && channel.title !== '.') {
          const site_id = channel.id;
          const name = channel.title;
          const logo = channel.transparentImageUrl || channel.thumbnailImage || '';
          const items = channel.epg || [];

          // चॅनेलची बेसिक इन्फो साठवणे
          if (!allChannelsDict[site_id]) {
            allChannelsDict[site_id] = { id: site_id, name: name, logo: logo, epgItems: [] };
            reportDataDict[site_id] = { id: site_id, name: name, epg_generated: false };
          }

          // प्रोग्राम्स (EPG) डेटा साठवणे
          if (items.length > 0) {
            reportDataDict[site_id].epg_generated = true;
            items.forEach(item => {
              allChannelsDict[site_id].epgItems.push(item);
            });
          }
        }
      });

      offset += limit;
      requestCount++;

      // दर ५ रिक्वेस्ट्सनंतर (१०० चॅनेल्स झाल्यावर) ४५ सेकंदाचा ब्रेक जेणेकरून IP ब्लॉक होणार नाही
      if (requestCount % 5 === 0) {
        console.log('--- Batch of 100 channels done. Pausing 45 seconds to keep API safe ---');
        await sleep(45000);
      } else {
        await sleep(2000); // सामान्य गॅप २ सेकंद
      }
    }
  }

  console.log('\nAll 3 days data fetched! Assembling final XML and Files...');

  // २. XML स्ट्रक्चर तयार करणे
  // A) सर्व चॅनेल्स टॅग तयार करणे
  Object.values(allChannelsDict).forEach(ch => {
    xml += `  <channel id="${ch.id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // B) सर्व ३ दिवसांचे प्रोग्राम्स टॅग XML मध्ये जोडणे
  Object.values(allChannelsDict).forEach(ch => {
    ch.epgItems.forEach(item => {
      const startTime = dayjs(Number(item.startTime));
      const endTime = dayjs(Number(item.endTime));
      
      const start = startTime.isValid() ? startTime.format('YYYYMMDDHHmmss ZZ') : '';
      const stop = endTime.isValid() ? endTime.format('YYYYMMDDHHmmss ZZ') : '';

      if (start && stop) {
        xml += `  <programme start="${start}" stop="${stop}" channel="${ch.id}">\n`;
        xml += `    <title lang="en">${escapeXML(item.title || '')}</title>\n`;
        if (item.desc) {
          xml += `    <desc lang="en">${escapeXML(item.desc)}</desc>\n`;
        }
        if (item.boxCoverImage) {
          xml += `    <icon src="${escapeXML(item.boxCoverImage)}" />\n`;
        }
        xml += `  </programme>\n`;
      }
    });
  });

  xml += '</tv>';

  // ३. फोल्डर आणि फाईल्स सेव्ह करणे
  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  const gzipContent = zlib.gzipSync(xml);
  fs.writeFileSync('./epg/tataplay.xml.gz', gzipContent);
  
  const reportList = Object.values(reportDataDict);
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportList, null, 2), 'utf-8');

  console.log(`\n==================================================`);
  console.log(`SUCCESS! 3-Day EPG generated for ${reportList.length} channels.`);
  console.log(`Files saved: ./epg/tataplay.xml, ./epg/tataplay.xml.gz, ./epg/channels_report.json`);
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

function setHeaders() {
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://watch.tataplay.com',
    'Referer': 'https://watch.tataplay.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'content-type': 'application/json',
    'locale': 'ENG',
     me: 'web'
  };
}

generateEPG();
