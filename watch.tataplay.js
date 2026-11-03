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
  console.log('Starting EPG generation with full debugging...');
  
  let channels = [];
  let reportData = [];
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-Custom">\n';

  try {
    let offset = 0;
    let limit = 50; // सुरक्षितपणे ५० च्या बॅचमध्ये डेटा मागवू
    let total = 836;

    while (offset < total) {
      console.log(`Fetching channels from offset: ${offset} (Limit: ${limit})...`);
      
      try {
        const resp = await axios.get(
          `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=&languageFilters=&genreFilters=&limit=${limit}&offset=${offset}`,
          { headers: setHeaders() }
        );

        const data = resp.data?.data;
        if (!data || !data.channelList) {
          console.log(`No channel list found at offset ${offset}. Response:`, JSON.stringify(resp.data));
          break;
        }

        total = data.total || total;
        const channelList = data.channelList;
        console.log(`Received ${channelList.length} channels from offset ${offset}. Total expected: ${total}`);

        channelList.forEach(channel => {
          if (channel.title && channel.title !== '.') {
            const site_id = channel.id;
            const name = channel.title;
            const logo = channel.transparentImageUrl || channel.thumbnailImage || '';
            const items = channel.epg || [];

            // XML मध्ये चॅनेल जोडणे
            xml += `  <channel id="${site_id}">\n`;
            xml += `    <display-name>${escapeXML(name)}</display-name>\n`;
            if (logo) {
              xml += `    <icon src="${escapeXML(logo)}" />\n`;
            }
            xml += `  </channel>\n`;

            let hasEpg = false;

            // XML मध्ये प्रोग्राम्स (EPG) जोडणे
            if (items.length > 0) {
              hasEpg = true;
              items.forEach(item => {
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

            reportData.push({
              id: site_id,
              name: name,
              epg_generated: hasEpg
            });
          }
        });

      } catch (err) {
        console.error(`Error at offset ${offset}:`, err.response?.status || err.message);
        // 429 आल्यास १० सेकंद थांबून पुन्हा प्रयत्न करू (Rate limit cooldown)
        if (err.response?.status === 429) {
          console.log('Rate limited (429). Waiting for 10 seconds before retrying...');
          await sleep(10000);
          continue; // तीच स्टेप पुन्हा प्रयत्न करण्यासाठी
        }
      }

      offset += limit;
      // प्रत्येक रिक्वेस्टनंतर १ सेकंदाचा मोठा डिले जेणेकरून 429 एरर येणार नाही
      await sleep(1000);
    }

  } catch (error) {
    console.error('Critical Error in generateEPG:', error.message);
  }

  xml += '</tv>';

  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  const gzipContent = zlib.gzipSync(xml);
  fs.writeFileSync('./epg/tataplay.xml.gz', gzipContent);
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportData, null, 2), 'utf-8');

  console.log(`Debugging completed. Total processed channels in report: ${reportData.length}`);
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
