const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');

async function runSamsungDemo() {
  console.log('=== Samsung & Elitebeam Direct Demo EPG Generator ===');

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Demo-Combined-EPG">\n';

  // १. channels.json मधून फक्त samsungtvplus चे चॅनेल्स शोधून त्यांचे <channel> टॅग्ज आणि ईपीजी गोळा करणे
  if (fs.existsSync('./channels.json')) {
    try {
      const fileContent = fs.readFileSync('./channels.json', 'utf-8');
      const parsed = JSON.parse(fileContent);
      const channels = Array.isArray(parsed) ? parsed : (parsed.channels || []);

      const samsungChannels = channels.filter(ch => ch.source === 'samsungtvplus');
      console.log(`Found ${samsungChannels.length} Samsung channels in channels.json.`);

      // सॅमसंगची झिप XML फाईल डाउनलोड करणे
      console.log('Downloading remote Samsung EPG XML...');
      const res = await axios.get('https://i.mjh.nz/SamsungTVPlus/in.xml.gz', { responseType: 'arraybuffer', timeout: 30000 });
      const samsungXml = zlib.gunzipSync(Buffer.from(res.data)).toString('utf-8');

      // प्रत्येक सॅमसंग चॅनेलसाठी चॅनेल टॅग आणि त्याचे प्रोग्राम्स थेट XML मध्ये टाकणे
      samsungChannels.forEach(ch => {
        const sId = String(ch.channel_id || ch.id);
        const sName = ch.name || 'Samsung Channel';
        const sLogo = ch.logo || '';

        // Channel Tag
        xml += `  <channel id="${sId}">\n`;
        xml += `    <display-name>${escapeXML(sName)}</display-name>\n`;
        if (sLogo) {
          xml += `    <icon src="${escapeXML(sLogo)}" />\n`;
        }
        xml += `  </channel>\n`;
      });

      // Programme Blocks थेट सॅमसंग फाईलमधून मॅच करून काढणे
      samsungChannels.forEach(ch => {
        const sId = String(ch.channel_id || ch.id);
        const progRegex = new RegExp(`(<programme[^>]*channel=["']${sId}["'][\\s\\S]*?<\/programme>)`, 'gi');
        let match;
        let count = 0;

        while ((match = progRegex.exec(samsungXml)) !== null) {
          xml += `  ${match[1]}\n`;
          count++;
        }
        console.log(`[Samsung] Injected ${count} programmes for channel ID: ${sId}`);
      });

    } catch (err) {
      console.error('Error fetching Samsung EPG:', err.message);
    }
  } else {
    console.log('channels.json not found!');
  }

  // २. Elitebeam Custom Channels (Movies & Music) मॅन्युअली ऍड करणे
  const elitebeamChannels = [
    { id: 'Elitebeam_Movies', name: 'Elitebeam Movies' },
    { id: 'Elitebeam_Music', name: 'Elitebeam Music' }
  ];

  elitebeamChannels.forEach(eb => {
    // Channel Tag
    xml += `  <channel id="${eb.id}">\n`;
    xml += `    <display-name>${escapeXML(eb.name)}</display-name>\n`;
    xml += `  </channel>\n`;

    // 2-hour sample Programme block
    const startTime = '20261113000000 +0530';
    const stopTime = '20261114000000 +0530';
    const progTitle = eb.id === 'Elitebeam_Movies' ? 'Blockbuster Movie Stream' : 'Non-Stop Music Playlist';
    
    xml += `  <programme start="${startTime}" stop="${stopTime}" channel="${eb.id}">\n`;
    xml += `    <title lang="en">${escapeXML(progTitle)}</title>\n`;
    xml += `    <desc lang="en">${escapeXML('Enjoy non-stop entertainment on ' + eb.name)}</desc>\n`;
    xml += `  </programme>\n`;
  });

  xml += '</tv>';

  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg', { recursive: true });
  }

  fs.writeFileSync('./epg/demo_epg.xml', xml, 'utf-8');
  console.log('\nSUCCESS! Demo EPG saved as ./epg/demo_epg.xml');
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

runSamsungDemo();
