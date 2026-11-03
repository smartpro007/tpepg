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
  console.log('Fetching channels...');
  const channels = await fetchChannels();
  console.log(`Total channels found: ${channels.length}`);
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-Custom">\n';

  // 1. सर्व चॅनेल XML मध्ये जोडणे
  channels.forEach(ch => {
    xml += `  <channel id="${ch.site_id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // फक्त आजचा दिवस (Present day)
  const today = dayjs().tz('Asia/Kolkata');
  const dateStr = today.format('DD-MM-YYYY');
  console.log(`Processing EPG for Present Day: ${dateStr}`);

  let reportData = [];

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
      }
    } catch (err) {
      hasEpg = false;
    }

    // रिपोर्टसाठी डेटा गोळा करणे
    reportData.push({
      id: ch.site_id,
      name: ch.name,
      epg_generated: hasEpg
    });

    // सर्व्हर ब्लॉक करू नये म्हणून छोटा डिले
    await sleep(80);
  }

  xml += '</tv>';

  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  // XML आणि GZ फाईल्स सेव्ह करणे
  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  const gzipContent = zlib.gzipSync(xml);
  fs.writeFileSync('./epg/tataplay.xml.gz', gzipContent);

  // चॅनेल रिपोर्ट JSON फाईल सेव्ह करणे
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportData, null, 2), 'utf-8');

  console.log('EPG and Report generated successfully in ./epg/ !');
}

async function fetchChannels() {
  let channels = [];
  let offset = 0;
  let total = 20;

  try {
    const firstResp = await axios.get(
      `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=&languageFilters=&genreFilters=&limit=20&offset=0`,
      { headers: setHeaders() }
    );
    total = firstResp.data.data.total || 100;
  } catch (e) {}

  while (offset < total) {
    try {
      const resp = await axios.get(
        `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=&languageFilters=&genreFilters=&limit=20&offset=${offset}`,
        { headers: setHeaders() }
      );
      resp.data.data.channelList.forEach(channel => {
        if (channel.title !== '.') {
          channels.push({
            site_id: channel.id,
            name: channel.title,
            logo: channel.transparentImageUrl || channel.thumbnailImage || ''
          });
        }
      });
    } catch (error) {}
    offset += 20;
    await sleep(50);
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
