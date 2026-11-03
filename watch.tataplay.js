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
  console.log('Fetching all channels from Tata Play...');
  const channels = await fetchChannels();
  console.log(`Total channels successfully fetched: ${channels.length}`);
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-Custom">\n';

  // 1. चॅनेल XML मध्ये जोडणे
  channels.forEach(ch => {
    xml += `  <channel id="${ch.site_id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // आजचा दिवस (Present day)
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

    // 429 एरर टाळण्यासाठी प्रत्येक चॅनेलमध्ये १५० मिलीसेकंद डिले
    await sleep(150);
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

async function fetchChannels() {
  let channels = [];
  let offset = 0;
  let limit = 20; // छोट्या बॅचमध्ये चॅनेल फेच करू जेणेकरून 429 एरर येणार नाही
  let total = 836;

  while (offset < total) {
    try {
      const resp = await axios.get(
        `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=&languageFilters=&genreFilters=&limit=${limit}&offset=${offset}`,
        { headers: setHeaders() }
      );
      
      const channelList = resp.data?.data?.channelList || [];
      if (channelList.length === 0) break;

      channelList.forEach(channel => {
        if (channel.title && channel.title !== '.') {
          channels.push({
            site_id: channel.id,
            name: channel.title,
            logo: channel.transparentImageUrl || channel.thumbnailImage || ''
          });
        }
      });

      total = resp.data?.data?.total || total;
    } catch (error) {
      console.error(`Error fetching channels at offset ${offset}:`, error.message);
    }

    offset += limit;
    await sleep(200); // चॅनेल लिस्ट फेच करताना डिले
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
