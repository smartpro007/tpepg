const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');

async function appendSamsungToExistingEpg() {
  console.log('=== Adding Samsung TV Plus to existing tataplay.xml.gz ===');

  try {
    // १. आधीची tataplay.xml फाईल अनझिप करून वाचणे (जर असेल तर)
    let existingXml = '';
    if (fs.existsSync('./epg/tataplay.xml.gz')) {
      const fileBuffer = fs.readFileSync('./epg/tataplay.xml.gz');
      existingXml = zlib.gunzipSync(fileBuffer).toString('utf-8');
      console.log('Existing tataplay.xml.gz loaded successfully.');
    } else if (fs.existsSync('./epg/tataplay.xml')) {
      existingXml = fs.readFileSync('./epg/tataplay.xml', 'utf-8');
      console.log('Existing tataplay.xml loaded successfully.');
    } else {
      console.log('Error: Existing tataplay.xml or xml.gz not found!');
      return;
    }

    // २. channels.json मधून सॅमसंगचे चॅनेल्स शोधणे
    if (!fs.existsSync('./channels.json')) {
      console.log('Error: channels.json not found!');
      return;
    }

    const channelsContent = fs.readFileSync('./channels.json', 'utf-8');
    const parsedChannels = JSON.parse(channelsContent);
    const channelsList = Array.isArray(parsedChannels) ? parsedChannels : (parsedChannels.channels || []);
    const samsungChannels = channelsList.filter(ch => ch.source === 'samsungtvplus');

    if (samsungChannels.length === 0) {
      console.log('No samsungtvplus channels found in channels.json.');
      return;
    }

    console.log(`Found ${samsungChannels.length} Samsung channels. Downloading remote EPG XML...`);

    // ३. सॅमसंगची EPG XML फाईल डाउनलोड करणे
    const res = await axios.get('https://i.mjh.nz/SamsungTVPlus/in.xml.gz', { responseType: 'arraybuffer', timeout: 30000 });
    const samsungXml = zlib.gunzipSync(Buffer.from(res.data)).toString('utf-8');

    // ४. सॅमसंगचे चॅनेल आणि प्रोग्राम टॅग्ज तयार करणे
    let samsungChannelsXml = '';
    let samsungProgrammesXml = '';

    samsungChannels.forEach(ch => {
      const sId = String(ch.channel_id || ch.id);
      const sName = ch.name || 'Samsung Channel';
      const sLogo = ch.logo || '';

      // जर आधीच फाईलमध्ये हा चॅनेल नसेल तरच चॅनेल टॅग जोडू
      if (!existingXml.includes(`id="${sId}"`)) {
        samsungChannelsXml += `  <channel id="${sId}">\n`;
        samsungChannelsXml += `    <display-name>${escapeXML(sName)}</display-name>\n`;
        if (sLogo) {
          samsungChannelsXml += `    <icon src="${escapeXML(sLogo)}" />\n`;
        }
        samsungChannelsXml += `  </channel>\n`;
      }

      // मूळ सॅमसंग फाईलमधून या चॅनेलचे प्रोग्राम्स काढणे
      const progRegex = new RegExp(`(<programme[^>]*channel=["']${sId}["'][\\s\\S]*?<\/programme>)`, 'gi');
      let match;
      let count = 0;
      while ((match = progRegex.exec(samsungXml)) !== null) {
        samsungProgrammesXml += `  ${match[1]}\n`;
        count++;
      }
      console.log(`[Samsung] Appended ${count} programmes for channel: ${sName} (${sId})`);
    });

    // ५. </tv> टॅगच्या आधी सॅमसंगचा डेटा इन्जेक्ट करणे
    if (existingXml.includes('</tv>')) {
      // चॅनेल टॅग्ज आणि प्रोग्राम्स </tv> च्या आधी व्यवस्थित बसवणे
      const insertionText = samsungChannelsXml + samsungProgrammesXml + '</tv>';
      existingXml = existingXml.replace('</tv>', insertionText);
    } else {
      existingXml += samsungChannelsXml + samsungProgrammesXml + '\n</tv>';
    }

    // ६. फायनल अपडेटेड XML पुन्हा tataplay.xml आणि tataplay.xml.gz मध्ये सेव्ह करणे
    fs.writeFileSync('./epg/tataplay.xml', existingXml, 'utf-8');
    fs.writeFileSync('./epg/tataplay.xml.gz', zlib.gzipSync(existingXml));

    console.log('SUCCESS! Samsung TV Plus EPG successfully merged into tataplay.xml.gz without disturbing existing data.');

  } catch (err) {
    console.error('Error merging Samsung EPG:', err.message);
  }
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

appendSamsungToExistingEpg();
