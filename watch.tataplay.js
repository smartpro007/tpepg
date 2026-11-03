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
  console.log('Fetching all channels and EPG data in one go from Tata Play...');
  
  let channels = [];
  let reportData = [];
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-Custom">\n';

  try {
    // सरळ एकाच यूआरएलवरून सर्व चॅनेल्स आणि त्यांचा ईपीजी डेटा मिळवणे (पेज बाय पेज लूप करून)
    let offset = 0;
    let limit = 100; // एका वेळी १०० चॅनेल्स मागवणे
    let total = 836;

    while (offset < total) {
      const resp = await axios.get(
        `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=&languageFilters=&genreFilters=&limit=${limit}&offset=${offset}`,
        { headers: setHeaders() }
      );

      const data = resp.data?.data;
      if (!data || !data.channelList) break;

      total = data.total || total;
      const channelList = data.channelList;

      channelList.forEach(channel => {
        if (channel.title && channel.title !== '.') {
          const site_id = channel.id;
          const name = channel.title;
          const logo = channel.transparentImageUrl || channel.thumbnailImage || '';
          const items = channel.epg || [];

          // 1. चॅनेल टॅग XML मध्ये जोडणे
          xml += `  <channel id="${site_id}">\n`;
          xml += `    <display-name>${escapeXML(name)}</display-name>\n`;
          if (logo) {
            xml += `    <icon src="${escapeXML(logo)}" />\n`;
          }
          xml += `  </channel>\n`;

          let hasEpg = false;

          // 2. त्या चॅनेलचे प्रोग्राम्स (EPG) XML मध्ये जोडणे
          if (items.length > 0) {
            hasEpg = true;
            items.forEach(item => {
              // मिलिसेकंदात असणारा टाईम व्यवस्थित फॉरमॅट करणे
              const startTime = dayjs(Number(item.startTime));
              const endTime = dayjs(Number(item.endTime));
              
              const start = startTime.isValid() ? startTime.format('YYYYMMDDHHmmss ZZ') : '';
              const stop = endTime.isValid() ? endTime.format('YYYYMMDDHHmmss ZZ') : '';

              if (start && stop) {
                xml += `  <programme start="${start}" stop="${stop}" channel="${site_id}">\n`;
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
          }

          // रिपोर्टसाठी डेटा साठवणे
          reportData.push({
            id: site_id,
            name: name,
            epg_generated: hasEpg
          });
        }
      });

      offset += limit;
      await sleep(200); // सर्व्हरवर ताण येऊ नये म्हणून छोटा डिले
    }

  } catch (error) {
    console.error('Error fetching data:', error.message);
  }

  xml += '</tv>';

  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  // फाईल्स सेव्ह करणे
  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  const gzipContent = zlib.gzipSync(xml);
  fs.writeFileSync('./epg/tataplay.xml.gz', gzipContent);
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportData, null, 2), 'utf-8');

  console.log(`Successfully processed ${reportData.length} channels and generated EPG files!`);
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
    'platform': 'web'
  };
}

generateEPG();
