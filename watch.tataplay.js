const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const fs = require('fs');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

async function generateEPG() {
  console.log('Fetching channels...');
  const channels = await fetchChannels();
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="TataPlay-EPG-Custom">\n';

  // Add channels to XML
  channels.forEach(ch => {
    xml += `  <channel id="${ch.site_id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // Calculate dates: 2 days past, today, 2 days future (Total 5 days)
  const today = dayjs().tz('Asia/Kolkata');
  for (let d = -2; d <= 2; d++) {
    const targetDate = today.add(d, 'day');
    const dateStr = targetDate.format('DD-MM-YYYY');
    console.log(`Fetching schedule for date: ${dateStr}`);

    for (const ch of channels) {
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
      } catch (err) {
        // Skip channel schedule errors silently to keep process running
      }
    }
  }

  xml += '</tv>';
  fs.writeFileSync('guide.xml', xml);
  console.log('guide.xml generated successfully!');
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
