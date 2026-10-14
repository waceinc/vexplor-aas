/**
 * Points the user's home and config folders at an empty temporary folder **before node-opcua loads**.
 *
 * Why a separate module imported first: node-opcua finds its default stores with env-paths, which reads the home folder
 * once when it is loaded. Setting HOME inside the test file would run after the imports and change nothing.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const fakeRoot = mkdtempSync(join(tmpdir(), 'aas-opcua-sec-'));
export const fakeHome = join(fakeRoot, 'home');
mkdirSync(fakeHome);

export const savedEnv = { HOME: process.env['HOME'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], APPDATA: process.env['APPDATA'] };
process.env['HOME'] = fakeHome;
process.env['XDG_CONFIG_HOME'] = join(fakeHome, '.config');
process.env['APPDATA'] = join(fakeHome, 'AppData');

export function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
