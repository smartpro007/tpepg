
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const xml2js = require('xml2js');

const ROOT = __dirname;
const CHANNELS_FILE = path.join(ROOT, 'channels.json');
const STALKER_FILE = path.join(ROOT, 'stalker.json');
const EPG_DIR = path.join(ROOT, 'epg');
const MASTER_XML = path.join(EPG_DIR, 'tataplay.xml');
const MASTER_GZ = path.join(EPG_DIR, 'tataplay.xml.gz');

const SAMSUNG_URL = 'https://i.mjh.nz/SamsungTVPlus/in.xml.gz';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    return [];
}

function getChannelList(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.list)) return data.list;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.channels)) return data.channels;
    if (Array.isArray(data?.data?.list)) return data.data.list;
    return [];
}

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&amp;/g, '&')
        .replace(/[^a-z0-9]/g, '');
}

function xmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function makeDate(timestamp) {
    return new Date(timestamp * 1000)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, ' +0000');
}

function getProgrammes(data) {
    const js = data?.js ?? data;
    if (Array.isArray(js)) return js;

    if (Array.isArray(js?.data?.data)) return js.data.data;
    if (Array.isArray(js?.data)) return js.data;
    if (Array.isArray(js?.programmes)) return js.programmes;
    if (Array.isArray(js?.epg)) return js.epg;

    return [];
}

function getStalkerChannels(data) {
    const js = data?.js ?? data;

    if (Array.isArray(js)) return js;
    if (Array.isArray(js?.data?.data)) return js.data.data;
    if (Array.isArray(js?.data)) return js.data;
    if (Array.isArray(js?.channels)) return js.channels;

    return [];
}

function buildChannel(channel) {
    return {
        $: { id: String(channel.id) },
        'display-name': [String(channel.name || channel.id)]
    };
}

function buildProgramme(channelId, programme) {
    const start = Number(
        programme.start_timestamp ??
        programme.start ??
        0
    );

    const stop = Number(
        programme.stop_timestamp ??
        programme.stop ??
        0
    );

    if (!start || !stop || stop <= start) return null;

    const title = String(
        programme.name ??
        programme.title ??
        'Unknown'
    );

    const description = String(
        programme.descr ??
        programme.description ??
        ''
    );

    const item = {
        $: {
            start: makeDate(start),
            stop: makeDate(stop),
            channel: String(channelId)
        },
        title: [{
            $: { lang: 'en' },
            _: title
        }]
    };

    if (description) {
        item.desc = [{
            $: { lang: 'en' },
            _: description
        }];
    }

    return item;
}

async function requestPortal(url, headers, timeout) {
    const response = await axios.get(url, {
        headers,
        timeout,
        responseType: 'text',
        transformResponse: [data => data],
        maxRedirects: 5,
        decompress: true,
        validateStatus: () => true
    });

    if (response.status !== 200) {
        const action = new URL(url).searchParams.get('action') || 'unknown';
        const body = String(response.data || '').slice(0, 250);

        throw new Error(
            `Portal HTTP ${response.status} | Action: ${action} | Response: ${body}`
        );
    }

    if (typeof response.data !== 'string') {
        throw new Error('Portal returned an invalid response');
    }

    try {
        return JSON.parse(response.data);
    } catch {
        throw new Error(
            'Portal JSON parsing failed: ' +
            response.data.slice(0, 200)
        );
    }
}

async function fetchStalkerEPG(targetChannels, config) {
    const settings = config.settings || {};
    const device = config.device || {};
    const portal = config.portal || {};
    const headerConfig = config.headers || {};

    if (settings.enabled === false || settings.epg_enabled === false) {
        console.log('Stalker Portal is disabled in stalker.json');
        return { channels: [], programmes: [], failed: 0 };
    }

    const baseUrl = portal.base_url;
    if (!baseUrl) {
        throw new Error('stalker.json: portal.base_url is missing');
    }

    const mac = device.mac || '';
    if (!mac) {
        throw new Error('stalker.json: device.mac is missing');
    }

    const timeout = Number(settings.request_timeout || 20000);
    const delay = Number(settings.request_delay || 250);

    const userAgent = headerConfig.user_agent ||
        'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stb app ver: 2 rev: 250 Safari/533.3';

    const referer = portal.referer ||
        'http://4k.tvstb.me/stalker_portal/c/';

    // PHP प्रमाणेच Cookie आणि headers
    const headers = {
        'User-Agent': userAgent,
        'X-User-Agent': headerConfig.x_user_agent ||
            'Model: MAG250; Link: WiFi',
        'Referer': referer,
        'Cookie': `mac=${mac}; stb_lang=${headerConfig.language || 'en'}; timezone=${headerConfig.timezone || 'Asia/Kolkata'}`,
        'Accept': '*/*',
        'Connection': 'keep-alive'
    };

    // 1. Handshake
    console.log('Stalker: Handshake...');

    const handshakeURL = new URL(baseUrl);
    handshakeURL.searchParams.set('type', 'stb');
    handshakeURL.searchParams.set('action', 'handshake');
    handshakeURL.searchParams.set('prehash', mac);
    handshakeURL.searchParams.set('token', '');
    handshakeURL.searchParams.set('JsHttpRequest', '1-xml');

    const handshake = await requestPortal(
        handshakeURL.toString(),
        headers,
        timeout
    );

    const token = handshake?.js?.token || handshake?.token || '';

    if (!token) {
        throw new Error('Handshake token not received');
    }

    // 2. Authorization
    const authHeaders = {
        ...headers,
        'Authorization': `Bearer ${token}`
    };

    // 3. Get Profile
    console.log('Stalker: Getting profile...');

    const profileURL = new URL(baseUrl);
    profileURL.searchParams.set('type', 'stb');
    profileURL.searchParams.set('action', 'get_profile');
    profileURL.searchParams.set('sn', device.serial_number || '');
    profileURL.searchParams.set('device_id', device.device_id || '');
    profileURL.searchParams.set('device_id2', device.device_id2 || '');
    profileURL.searchParams.set('signature', device.signature || '263');
    profileURL.searchParams.set('JsHttpRequest', '1-xml');

    await requestPortal(
        profileURL.toString(),
        authHeaders,
        timeout
    );

    await sleep(delay);

    // 4. Get All Channels
    console.log('Stalker: Getting channel list...');

    const channelsURL = new URL(baseUrl);
    channelsURL.searchParams.set('type', 'itv');
    channelsURL.searchParams.set('action', 'get_all_channels');
    channelsURL.searchParams.set('JsHttpRequest', '1-xml');

    const channelResponse = await requestPortal(
        channelsURL.toString(),
        authHeaders,
        timeout
    );

    const portalChannels = getStalkerChannels(channelResponse);

    if (!portalChannels.length) {
        throw new Error('Stalker channel list is empty or invalid');
    }

    console.log(`Stalker: Portal channels found: ${portalChannels.length}`);

    const portalById = new Map();
    const portalByName = new Map();

    for (const item of portalChannels) {
        const id = String(item.id ?? item.ch_id ?? '');
        const name = String(item.name ?? item.title ?? '');

        if (id) portalById.set(id, item);

        const normalized = normalizeName(name);
        if (normalized && !portalByName.has(normalized)) {
            portalByName.set(normalized, item);
        }
    }

    const outputChannels = [];
    const outputProgrammes = [];
    let failed = 0;
    let matched = 0;

    // 5. Match channels and get EPG
    for (const target of targetChannels) {
        const targetId = String(target.channel_id ?? '');
        const targetName = String(target.name ?? '');

        let portalChannel = portalById.get(targetId);

        if (!portalChannel) {
            portalChannel = portalByName.get(
                normalizeName(targetName)
            );
        }

        if (!portalChannel) {
            console.log(`Stalker: Channel not matched: ${targetName}`);
            continue;
        }

        const apiId = String(
            portalChannel.id ??
            portalChannel.ch_id ??
            ''
        );

        if (!apiId) continue;

        matched++;

        outputChannels.push({
            id: targetId,
            name: targetName || portalChannel.name || targetId
        });

        const epgURL = new URL(baseUrl);
        epgURL.searchParams.set('type', 'itv');
        epgURL.searchParams.set('action', 'get_short_epg');
        epgURL.searchParams.set('tv_genre_id', '0');
        epgURL.searchParams.set('not_ended', '1');
        epgURL.searchParams.set('ch_id', apiId);
        epgURL.searchParams.set('JsHttpRequest', '1-xml');

        try {
            await sleep(delay);

            const epgResponse = await requestPortal(
                epgURL.toString(),
                authHeaders,
                timeout
            );

            const programmes = getProgrammes(epgResponse);

            for (const programme of programmes) {
                const item = buildProgramme(targetId, programme);
                if (item) outputProgrammes.push(item);
            }

        } catch (error) {
            failed++;
            console.log(
                `Stalker EPG failed for ${targetName}: ${error.message}`
            );
        }
    }

    console.log(`Stalker matched channels: ${matched}`);
    console.log(`Stalker failed EPG requests: ${failed}`);
    console.log(`Stalker programmes received: ${outputProgrammes.length}`);

    return {
        channels: outputChannels,
        programmes: outputProgrammes,
        failed
    };
}

async function fetchSamsungEPG(targetChannels) {
    console.log('Fetching Samsung TV Plus EPG...');

    const response = await axios.get(SAMSUNG_URL, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 5
    });

    let buffer = Buffer.from(response.data);

    // GZIP असल्यास decompress करा
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        buffer = zlib.gunzipSync(buffer);
    }

    const parsed = await xml2js.parseStringPromise(
        buffer.toString('utf8'),
        { explicitArray: true }
    );

    const tv = parsed.tv || {};
    const sourceChannels = asArray(tv.channel);
    const sourceProgrammes = asArray(tv.programme);

    const wanted = new Map();

    for (const channel of targetChannels) {
        wanted.set(String(channel.channel_id), channel);
    }

    const foundChannels = [];
    const foundProgrammes = [];

    for (const channel of sourceChannels) {
        const sourceId = String(channel?.$?.id || '');
        const target = wanted.get(sourceId);

        if (!target) continue;

        foundChannels.push({
            id: String(target.channel_id),
            name: String(target.name || sourceId)
        });
    }

    const validIds = new Set(
        foundChannels.map(channel => channel.id)
    );

    for (const programme of sourceProgrammes) {
        const sourceId = String(programme?.$?.channel || '');

        if (!validIds.has(sourceId)) continue;

        const start = String(programme?.$?.start || '');
        const stop = String(programme?.$?.stop || '');

        if (!start || !stop) continue;

        const item = {
            $: {
                start,
                stop,
                channel: sourceId
            },
            title: [{
                $: { lang: 'en' },
                _: String(
                    programme?.title?.[0]?._ ??
                    programme?.title?.[0] ??
                    'Unknown'
                )
            }]
        };

        const desc = programme?.desc?.[0]?._ ??
            programme?.desc?.[0] ??
            '';

        if (desc) {
            item.desc = [{
                $: { lang: 'en' },
                _: String(desc)
            }];
        }

        foundProgrammes.push(item);
    }

    console.log(`Samsung channels matched: ${foundChannels.length}`);
    console.log(`Samsung programmes extracted: ${foundProgrammes.length}`);

    return {
        channels: foundChannels,
        programmes: foundProgrammes
    };
}

async function mergeMasterEPG(managedChannels, newProgrammes) {
    let tv = {
        $: { 'generator-info-name': 'Master EPG Generator' },
        channel: [],
        programme: []
    };

    if (fs.existsSync(MASTER_XML)) {
        try {
            const oldXML = fs.readFileSync(MASTER_XML, 'utf8');
            const oldParsed = await xml2js.parseStringPromise(
                oldXML.replace(/^\uFEFF/, ''),
                { explicitArray: true }
            );

            if (oldParsed.tv) {
                tv = oldParsed.tv;
            }
        } catch (error) {
            console.log('Existing XML could not be parsed:', error.message);
            throw new Error('Master XML is invalid; refusing to overwrite it');
        }
    }

    tv.channel = asArray(tv.channel);
    tv.programme = asArray(tv.programme);

    const managedIds = new Set(
        managedChannels.map(channel => String(channel.id))
    );

    // आधीच्या managed channels आणि programmes काढा
    tv.channel = tv.channel.filter(
        channel => !managedIds.has(String(channel?.$?.id || ''))
    );

    tv.programme = tv.programme.filter(
        programme => !managedIds.has(
            String(programme?.$?.channel || '')
        )
    );

    // नवीन channel definitions
    for (const channel of managedChannels) {
        tv.channel.push(buildChannel(channel));
    }

    // नवीन programmes
    tv.programme.push(...newProgrammes);

    const builder = new xml2js.Builder({
        xmldec: {
            version: '1.0',
            encoding: 'UTF-8'
        },
        renderOpts: {
            pretty: true,
            indent: '  ',
            newline: '\n'
        }
    });

    const xml = builder.buildObject({ tv });
    const cleanXML = xml.replace(/^\uFEFF/, '').trim() + '\n';

    fs.mkdirSync(EPG_DIR, { recursive: true });

    fs.writeFileSync(MASTER_XML, cleanXML, 'utf8');
    fs.writeFileSync(
        MASTER_GZ,
        zlib.gzipSync(Buffer.from(cleanXML, 'utf8'))
    );

    return {
        channels: managedChannels.length,
        programmes: newProgrammes.length
    };
}

async function generateMasterEPG() {
    console.log('Starting Master EPG Generation (Samsung + Stalker)...');

    if (!fs.existsSync(CHANNELS_FILE)) {
        throw new Error('channels.json not found');
    }

    if (!fs.existsSync(STALKER_FILE)) {
        throw new Error('stalker.json not found');
    }

    const allChannels = getChannelList(readJSON(CHANNELS_FILE));
    const stalkerConfig = readJSON(STALKER_FILE);

    if (!allChannels.length) {
        throw new Error('No channels found in channels.json');
    }

    const samsungTargets = allChannels.filter(
        channel => String(channel.source || '').toLowerCase() === 'samsungtvplus'
    );

    const stalkerTargets = allChannels.filter(
        channel => String(channel.source || '').toLowerCase() === '4k.tvstb.me'
    );

    console.log(`Samsung target channels: ${samsungTargets.length}`);
    console.log(`Stalker target channels: ${stalkerTargets.length}`);

    let samsungResult = { channels: [], programmes: [] };
    let stalkerResult = { channels: [], programmes: [], failed: 0 };

    // Samsung EPG
    if (samsungTargets.length) {
        try {
            samsungResult = await fetchSamsungEPG(samsungTargets);
        } catch (error) {
            console.log('Samsung EPG Error:', error.message);
        }
    }

    // Stalker Portal EPG
    if (stalkerTargets.length) {
        try {
            stalkerResult = await fetchStalkerEPG(
                stalkerTargets,
                stalkerConfig
            );
        } catch (error) {
            console.log('Stalker Portal Error:', error.message);
        }
    }

    const managedChannels = [
        ...samsungResult.channels,
        ...stalkerResult.channels
    ];

    const programmes = [
        ...samsungResult.programmes,
        ...stalkerResult.programmes
    ];

    const result = await mergeMasterEPG(
        managedChannels,
        programmes
    );

    console.log('');
    console.log('----------------------------------');
    console.log('MASTER EPG GENERATION COMPLETED');
    console.log('----------------------------------');
    console.log(`Channels Added: ${result.channels}`);
    console.log(`Programmes Added: ${result.programmes}`);
    console.log(`Samsung Channels: ${samsungResult.channels.length}`);
    console.log(`Samsung Programmes: ${samsungResult.programmes.length}`);
    console.log(`Stalker Channels: ${stalkerResult.channels.length}`);
    console.log(`Stalker Programmes: ${stalkerResult.programmes.length}`);
    console.log(`Stalker Failed Requests: ${stalkerResult.failed}`);
    console.log(`XML: epg/tataplay.xml`);
    console.log(`GZIP: epg/tataplay.xml.gz`);
}

generateMasterEPG().catch(error => {
    console.error('FATAL ERROR:', error.message);
    process.exitCode = 1;
});
