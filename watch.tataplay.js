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
  console.log('Fetching all channels in a single/optimized request...');
  const channels = await fetchChannelsDirectly();
  console.log(`Total channels successfully fetched: ${channels.length}`);
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-Custom">\n';

  channels.forEach(ch => {
    xml += `  <channel id="${ch.site_id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  const today = dayjs().tz('Asia/Kolkata');
  const dateStr = today.format('DD-MM-YYYY');
  console.log(`Processing EPG for Present Day: ${dateStr}`);

  let reportData = [];
  let successCount = 0;
  let failCount = 0;

  for (const ch of channels) {
    let hasEpg = false;
    try {
      const response = await axios.post(
        'https://tm.tapi.videoready.tv/content-detail/pub/api/v2/channels/schedule',
        { id: ch.site_id },
        {
          params: { date: dateStr },
          headers: setHeaders()
        }
      );

      const items = response.data?.data?.epg || [];
      if (items.length > 0) {
        hasEpg = true;
        successCount++;
        items.forEach(item => {
          const start = dayjs(item.startTime).format('YYYYMMDDHHmmss ZZ');
          const stop = dayjs(item.endTime).format('YYYYMMDDHHmmss ZZ');
          
          xml += `  <programme start="${start}" stop="${stop}" channel="${ch.site_id}">\n`;
          xml += `    <title lang="en">${escapeXML(item.title || '')}</title>\n`;
          if (item.desc) {
            xml += `    <desc lang="en">${escapeXML(item.desc)}</desc>\n`;
          }
          if (item.boxCoverImage) {
            xml += `    <icon src="${escapeXML(item.boxCoverImage)}" />\n`;
          }
          xml += `  </programme>\n`;
        });
      } else {
        failCount++;
      }
    } catch (err) {
      hasEpg = false;
      failCount++;
    }

    reportData.push({
      id: ch.site_id,
      name: ch.name,
      epg_generated: hasEpg
    });

    // प्रोग्राम शेड्यूल फेच करताना थोडा वेळ देणे
    await sleep(200);
  }

  xml += '</tv>';

  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  const gzipContent = zlib.gzipSync(xml);
  fs.writeFileSync('./epg/tataplay.xml.gz', gzipContent);
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportData, null, 2), 'utf-8');

  console.log(`EPG generated! Success: ${successCount}, Failed/No EPG: ${failCount}`);
}

async function fetchChannelsDirectly() {
  let channels = [];
  try {
    // एकाच रिक्वेस्टमध्ये जास्तीत जास्त चॅनेल्स मागवण्यासाठी limit 1000 सेट केली आहे
    const resp = await axios.get(
      `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=&languageFilters=&genreFilters=&limit=1000&offset=0`,
      { headers: setHeaders() }
    );
    
    const channelList = resp.data?.data?.channelList || [];
    channelList.forEach(channel => {
      if (channel.title && channel.title !== '.') {
        channels.push({
          site_id: channel.id,
          name: channel.title,
          logo: channel.transparentImageUrl || channel.thumbnailImage || ''
        });
      }
    });
  } catch (error) {
    console.error('Error fetching all channels at once:', error.message);
  }

  return channels;
}

function escapeXML(str) {
  return str.replace(/[<>&'"]/g, c => {
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
    'platform': 'web'
  };
}

generateEPG();
