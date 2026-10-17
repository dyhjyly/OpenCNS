import { one } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 天气 + 主页头部数据。
 *
 * 为什么走服务端而不是浏览器直连：
 *   · 手机网络（尤其国内）访问 open-meteo 不一定稳，服务端出海干净
 *   · 可以缓存，避免每次打开首页都打一次外网
 *   · 定位坐标从浏览器拿，城市名兜底从设置里读
 */

export interface WeatherInfo {
  ok: boolean;
  /** 界面上的地名标签：有定位就是"当前位置"，否则是设置里的地区 */
  label: string | null;
  /** 设置里写的那个地区（用来对比"你在外面还是在武汉"） */
  city: string | null;
  region: string | null;
  text: string;
  temperature: number | null;
  apparent: number | null;
  humidity: number | null;
  wind: number | null;
  low: number | null;
  high: number | null;
  code: number | null;
  /** 一句人话提醒 */
  tip: string;
  updatedAt: string;
}

/** WMO weather code → 中文 + 图标键 */
const CODES: Record<number, { text: string; key: string }> = {
  0: { text: '晴', key: 'sun' },
  1: { text: '晴间多云', key: 'sun-cloud' },
  2: { text: '多云', key: 'cloud' },
  3: { text: '阴', key: 'cloud' },
  45: { text: '雾', key: 'fog' },
  48: { text: '雾凇', key: 'fog' },
  51: { text: '毛毛雨', key: 'rain' },
  53: { text: '小雨', key: 'rain' },
  55: { text: '中雨', key: 'rain' },
  56: { text: '冻雨', key: 'rain' },
  57: { text: '冻雨', key: 'rain' },
  61: { text: '小雨', key: 'rain' },
  63: { text: '中雨', key: 'rain' },
  65: { text: '大雨', key: 'rain' },
  66: { text: '冻雨', key: 'rain' },
  67: { text: '冻雨', key: 'rain' },
  71: { text: '小雪', key: 'snow' },
  73: { text: '中雪', key: 'snow' },
  75: { text: '大雪', key: 'snow' },
  77: { text: '雪粒', key: 'snow' },
  80: { text: '阵雨', key: 'rain' },
  81: { text: '阵雨', key: 'rain' },
  82: { text: '强阵雨', key: 'rain' },
  85: { text: '阵雪', key: 'snow' },
  86: { text: '强阵雪', key: 'snow' },
  95: { text: '雷阵雨', key: 'storm' },
  96: { text: '雷阵雨伴冰雹', key: 'storm' },
  99: { text: '雷暴伴冰雹', key: 'storm' },
};

function tipOf(code: number, temp: number | null): string {
  if (code >= 51 && code <= 67) return '外面在下雨，记得带伞。';
  if (code >= 80 && code <= 82) return '有阵雨，出门看一眼天。';
  if (code >= 71 && code <= 86) return '下雪了，路会滑，慢一点。';
  if (code >= 95) return '有雷，别在外面久留。';
  if (temp !== null && temp <= 5) return '今天很冷，多穿一件。';
  if (temp !== null && temp >= 33) return '很热，多喝水。';
  if (code === 0 || code === 1) return '天气不错，可以出门走走。';
  return '今天天气平稳。';
}

interface CacheEntry {
  at: number;
  data: WeatherInfo;
}

const cache = new Map<string, CacheEntry>();
const TTL = 10 * 60_000;

/** 兜底坐标：外网地理编码连不上时，至少这些城市还能出天气 */
const FALLBACK_COORDS: Record<string, { lat: number; lon: number; region: string }> = {
  驻马店: { lat: 32.9838, lon: 114.0259, region: '河南' },
  郑州: { lat: 34.7466, lon: 113.6254, region: '河南' },
  北京: { lat: 39.9042, lon: 116.4074, region: '北京' },
  上海: { lat: 31.2304, lon: 121.4737, region: '上海' },
  广州: { lat: 23.1291, lon: 113.2644, region: '广东' },
  深圳: { lat: 22.5431, lon: 114.0579, region: '广东' },
  珠海: { lat: 22.2707, lon: 113.5767, region: '广东' },
  杭州: { lat: 30.2741, lon: 120.1551, region: '浙江' },
  成都: { lat: 30.5728, lon: 104.0668, region: '四川' },
  武汉: { lat: 30.5928, lon: 114.3055, region: '湖北' },
  西安: { lat: 34.3416, lon: 108.9398, region: '陕西' },
  厦门: { lat: 24.4798, lon: 118.0894, region: '福建' },
  三亚: { lat: 18.2528, lon: 109.5119, region: '海南' },
  汕头: { lat: 23.3535, lon: 116.6820, region: '广东' },
};

async function geocode(city: string): Promise<{ lat: number; lon: number; name: string; region: string | null } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9_000) });
    if (!res.ok) {
      log.warn('地理编码失败', { city, status: res.status });
      return null;
    }
    const json = (await res.json()) as {
      results?: { latitude: number; longitude: number; name: string; admin1?: string }[];
    };
    const r = json.results?.[0];
    if (!r) {
      log.warn('地理编码没有结果', { city });
      return null;
    }
    return { lat: r.latitude, lon: r.longitude, name: r.name, region: r.admin1 ?? null };
  } catch (err) {
    // 不要静默吞掉：之前就是这里 catch 成 null，天气一直显示"定位不到"却查不到原因
    log.warn('地理编码请求异常，用内置坐标兜底', { city, ...errFields(err) });
    const fb = FALLBACK_COORDS[city];
    if (fb) return { lat: fb.lat, lon: fb.lon, name: city, region: fb.region };
    return null;
  }
}

export async function getWeather(opts: { lat?: number; lon?: number; city?: string; fresh?: boolean }): Promise<WeatherInfo> {
  let lat = opts.lat;
  let lon = opts.lon;
  let cityName: string | null = opts.city ?? null;
  let region: string | null = null;
  const hasCoords = opts.lat !== undefined && opts.lon !== undefined;

  // 标签用的城市名：优先传进来的，其次设置里的
  const settingCity = await one<{ value: unknown }>(`select value from settings where key = 'weather.city'`)
    .then((r) => (typeof r?.value === 'string' ? r.value.trim() : ''))
    .catch(() => '');
  const labelCity = cityName || settingCity || null;

  /** 有定位就显示"当前位置"；没有就用设置里的地区 */
  const labelOf = (name: string | null) => (hasCoords ? '当前位置' : (name ?? '你那边'));

  if (lat === undefined || lon === undefined) {
    const targetCity = cityName || settingCity || '驻马店';
    cityName = targetCity;
    const geo = await geocode(targetCity).catch(() => null);
    if (geo) {
      lat = geo.lat;
      lon = geo.lon;
      region = geo.region;
      cityName = geo.name;
    }
  } else {
    // 有坐标时不做反地理编码（open-meteo 不提供）。
    // 标签按她的要求显示"当前位置"——数据来自她的实际位置，
    // 而设置里的地区只是兜底与对照。
    cityName = labelCity;
  }

  if (lat === undefined || lon === undefined) {
    return {
      ok: false,
      label: labelOf(cityName),
      city: cityName,
      region,
      text: '定位不到',
      temperature: null,
      apparent: null,
      humidity: null,
      wind: null,
      low: null,
      high: null,
      code: null,
      tip: '允许定位，或者告诉我你在哪个城市。',
      updatedAt: new Date().toISOString(),
    };
  }

  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < TTL) {
    return { ...hit.data, label: labelOf(cityName), city: cityName ?? hit.data.city };
  }

  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min' +
    '&timezone=Asia%2FShanghai&forecast_days=1';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
    const j = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };

    const code = j.current?.weather_code ?? 0;
    const temp = j.current?.temperature_2m ?? null;
    const info: WeatherInfo = {
      ok: true,
      label: labelOf(cityName),
      city: cityName,
      region,
      text: CODES[code]?.text ?? '—',
      temperature: temp,
      apparent: j.current?.apparent_temperature ?? null,
      humidity: j.current?.relative_humidity_2m ?? null,
      wind: j.current?.wind_speed_10m ?? null,
      low: j.daily?.temperature_2m_min?.[0] ?? null,
      high: j.daily?.temperature_2m_max?.[0] ?? null,
      code,
      tip: tipOf(code, temp),
      updatedAt: new Date().toISOString(),
    };

    cache.set(key, { at: Date.now(), data: info });
    return info;
  } catch (err) {
    log.warn('取天气失败，用缓存或占位', errFields(err));
    if (hit) return { ...hit.data, label: labelOf(cityName) };
    return {
      ok: false,
      label: labelOf(cityName),
      city: cityName,
      region,
      text: '取不到',
      temperature: null,
      apparent: null,
      humidity: null,
      wind: null,
      low: null,
      high: null,
      code: null,
      tip: '天气服务暂时没连上。',
      updatedAt: new Date().toISOString(),
    };
  }
}

/** 主页需要的汇总：在一起多久 + 最近一次醒来 + 未读 */
export interface HomeSummary {
  together: { since: string; days: number; hours: number; minutes: number; seconds: number };
  now: { local: string; weekday: string; dayPart: string };
  lastWake: { decision: string | null; reason: string | null; at: string } | null;
  pendingOutbox: number;
  herLastMessage: string | null;
}

const SINCE = '2026-05-23T18:25:00+08:00';

export async function getHomeSummary(): Promise<HomeSummary> {
  const row = await one<{
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    local: string;
    weekday_cn: string;
    hour: number;
    pending: number;
    her_last: string | null;
  }>(
    `select
       floor(extract(epoch from (now() - timestamptz '${SINCE}')) / 86400)::int as days,
       extract(hour from (now() - timestamptz '${SINCE}'))::int as hours,
       extract(minute from (now() - timestamptz '${SINCE}'))::int as minutes,
       floor(extract(second from (now() - timestamptz '${SINCE}')))::int as seconds,
       to_char(now() at time zone 'Asia/Shanghai', 'HH24:MI') as local,
       extract(isodow from (now() at time zone 'Asia/Shanghai'))::int as weekday_cn,
       extract(hour from (now() at time zone 'Asia/Shanghai'))::int as hour,
       (select count(*)::int from outbox where status = 'pending') as pending,
       (select content from messages where role = 'user' order by seq desc limit 1) as her_last`,
  );

  const lastWakeRow = await one<{ decision: string | null; skipped_reason: string | null; created_at: string }>(
    `select decision, skipped_reason, created_at from wake_log order by created_at desc limit 1`,
  );

  const CN = ['一', '二', '三', '四', '五', '六', '日'];
  const hour = Number(row?.hour ?? 12);
  const dayPart =
    hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 11 ? '上午' : hour < 13 ? '中午' : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 23 ? '晚上' : '深夜';

  return {
    together: {
      since: SINCE,
      days: Number(row?.days ?? 0),
      hours: Number(row?.hours ?? 0),
      minutes: Number(row?.minutes ?? 0),
      seconds: Number(row?.seconds ?? 0),
    },
    now: {
      local: row?.local ?? '',
      weekday: `星期${CN[(Number(row?.weekday_cn ?? 1) - 1) % 7]}`,
      dayPart,
    },
    lastWake: lastWakeRow
      ? {
          decision: lastWakeRow.decision,
          reason: lastWakeRow.decision ? null : lastWakeRow.skipped_reason,
          at: lastWakeRow.created_at,
        }
      : null,
    pendingOutbox: Number(row?.pending ?? 0),
    herLastMessage: row?.her_last ?? null,
  };
}
