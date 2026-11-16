// config/user.json: your settings (gitignored; config/user.example.json shows every key). The city is private: tools
// never print it and tests never send it anywhere. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonStrict } from './fsx.mjs';

export const CONFIG_REL = 'config/user.json';
/** The neutral example to start config/user.json from. */
export const EXAMPLE_REL = 'config/user.example.json';
/** The problem a missing config/user.json reports (a fresh clone before its first step). */
export const MISSING_CONFIG = `${CONFIG_REL} is missing: copy ${EXAMPLE_REL} to ${CONFIG_REL} and put in your city, units, clock and links`;
export const CONFIG_KEYS = ['city', 'units', 'clock', 'sunTimes', 'weather', 'shortcuts', 'taskbarPx'];
/** shortcuts: the new tab's links [1]-[9] (PCD.settings.SHORTCUTS_MAX). */
export const LIMITS = Object.freeze({ city: 80, label: 24, url: 300, shortcuts: 9, taskbar: [0, 200] });

const isInt = (v) => Number.isInteger(v);

/** Problems with a parsed config (strings; [] when it is valid). Messages never contain the city. */
export function validateConfig(config) {
  const p = [];
  const at = (key) => `${CONFIG_REL}: "${key}"`;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [`${CONFIG_REL}: must be a JSON object`];
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) p.push(`${CONFIG_REL}: unknown key "${key}" (known: ${CONFIG_KEYS.join(', ')})`);
  }
  for (const key of CONFIG_KEYS) if (!(key in config)) p.push(`${at(key)} is missing`);
  if ('city' in config && (typeof config.city !== 'string' || config.city.length > LIMITS.city)) p.push(`${at('city')} must be a string of at most ${LIMITS.city} characters`);
  if ('units' in config && !['F', 'C'].includes(config.units)) p.push(`${at('units')} must be "F" or "C"`);
  if ('clock' in config && !['12h', '24h'].includes(config.clock)) p.push(`${at('clock')} must be "12h" or "24h"`);
  for (const key of ['sunTimes', 'weather']) if (key in config && typeof config[key] !== 'boolean') p.push(`${at(key)} must be true or false`);
  if ('shortcuts' in config) {
    const list = config.shortcuts;
    if (!Array.isArray(list) || list.length > LIMITS.shortcuts) p.push(`${at('shortcuts')} must be an array of at most ${LIMITS.shortcuts} { label, url }`);
    else {
      list.forEach((s, i) => {
        const where = `${at('shortcuts')}[${i}]`;
        if (!s || typeof s !== 'object' || Array.isArray(s)) { p.push(`${where} must be { label, url }`); return; }
        const extra = Object.keys(s).filter((k) => k !== 'label' && k !== 'url');
        if (extra.length) p.push(`${where} has unknown keys ${extra.join(', ')}`);
        if (typeof s.label !== 'string' || !s.label.trim() || s.label.length > LIMITS.label) p.push(`${where}.label must be 1-${LIMITS.label} characters`);
        let ok = typeof s.url === 'string' && s.url.length <= LIMITS.url;
        if (ok) {
          try { ok = ['http:', 'https:'].includes(new URL(s.url).protocol); } catch { ok = false; }
        }
        if (!ok) p.push(`${where}.url must be an http(s) URL of at most ${LIMITS.url} characters`);
      });
    }
  }
  const [tLo, tHi] = LIMITS.taskbar;
  if ('taskbarPx' in config && !(isInt(config.taskbarPx) && config.taskbarPx >= tLo && config.taskbarPx <= tHi)) {
    p.push(`${at('taskbarPx')} must be an integer from ${tLo} to ${tHi} (got ${JSON.stringify(config.taskbarPx)})`);
  }
  return p;
}

/** Strictly parse and validate root/config/user.json. Returns { config, problems }. */
export function loadConfig(root) {
  const file = path.join(root, ...CONFIG_REL.split('/'));
  if (!fs.existsSync(file)) return { config: null, problems: [MISSING_CONFIG] };
  let config = null;
  try {
    config = readJsonStrict(file, CONFIG_REL);
  } catch (e) {
    return { config: null, problems: [e.message] };
  }
  return { config, problems: validateConfig(config) };
}

/** Lower-case hosts of the configured shortcuts (for the URL allowlist). */
export function shortcutHosts(config) {
  const hosts = new Set();
  for (const s of (config && Array.isArray(config.shortcuts) ? config.shortcuts : [])) {
    try { hosts.add(new URL(s.url).hostname.toLowerCase()); } catch { /* invalid: reported by validateConfig */ }
  }
  return [...hosts];
}
