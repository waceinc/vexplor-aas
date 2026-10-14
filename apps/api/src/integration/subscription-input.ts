/**
 * Validation of subscription create / patch bodies (docs/design/integration-v1.md §4.2).
 *
 * Strict on purpose: an unknown field is an error, not ignored — a typo like `packageID` would otherwise subscribe to
 * every package and nobody would notice until the receiver drowned.
 */
import { DELIVERABLE_TYPES, fill, tr, typeMatches } from '@aas/core';
import type { SubscriptionKind, SubscriptionOptions } from '@aas/store';

import { ApiError } from '../http.js';
import { validTopicPrefix } from './mqtt-sink.js';

export interface SubscriptionInput {
  name?: string;
  kind?: SubscriptionKind;
  url?: string;
  types?: string[];
  packageIds?: string[];
  enabled?: boolean;
  options?: SubscriptionOptions;
}

const CREATE_KEYS = ['name', 'kind', 'url', 'types', 'packageIds', 'enabled', 'options'];
const PATCH_KEYS = ['name', 'url', 'types', 'packageIds', 'enabled', 'options'];

const bad = (text: string): ApiError => new ApiError(400, 'BadRequest', text);

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw bad(fill(tr('{0}은(는) 비어 있지 않은 문자열의 목록이어야 합니다.'), { 0: field }));
  }
  return [...new Set((value as string[]).map((item) => item.trim()))];
}

function options(value: unknown): SubscriptionOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(tr('options는 객체여야 합니다.'));
  const out: SubscriptionOptions = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'topicPrefix') {
      if (typeof item !== 'string' || !validTopicPrefix(item)) {
        throw bad(tr('topicPrefix는 200자 이하이고 +, #, NUL 문자가 없어야 합니다.'));
      }
      out.topicPrefix = item;
    } else if (key === 'retainState') {
      if (typeof item !== 'boolean') throw bad(tr('retainState는 true 또는 false여야 합니다.'));
      out.retainState = item;
    } else throw bad(fill(tr('알 수 없는 항목입니다: {0}'), { 0: `options.${key}` }));
  }
  return out;
}

/** Parses a create (all required except packageIds / enabled / options) or patch (all optional) body */
export function parseSubscriptionInput(body: unknown, mode: 'create' | 'patch'): SubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad(tr('본문은 JSON 객체여야 합니다.'));
  const allowed = mode === 'create' ? CREATE_KEYS : PATCH_KEYS;
  const input: SubscriptionInput = {};
  for (const [key, value] of Object.entries(body)) {
    if (mode === 'patch' && key === 'kind') {
      throw bad(tr('구독 종류(kind)는 바꿀 수 없습니다 — 다른 종류가 필요하면 새 구독을 만드십시오. 수정 요청에는 kind를 넣지 마십시오.'));
    }
    if (!allowed.includes(key)) throw bad(fill(tr('알 수 없는 항목입니다: {0}'), { 0: key }));
    switch (key) {
      case 'name':
        if (typeof value !== 'string' || value.trim() === '' || value.length > 200) throw bad(tr('name은 1~200자여야 합니다.'));
        input.name = value.trim();
        break;
      case 'kind':
        if (value !== 'webhook' && value !== 'mqtt') throw bad(tr('kind는 webhook 또는 mqtt여야 합니다.'));
        input.kind = value;
        break;
      case 'url':
        if (typeof value !== 'string' || value.trim() === '' || value.length > 2000) throw bad(tr('url이 비어 있거나 너무 깁니다.'));
        input.url = value.trim();
        break;
      case 'types': {
        const types = stringList(value, 'types');
        if (types.length === 0) throw bad(tr('types에 받을 이벤트 종류를 하나 이상 적으십시오 (모두 받으려면 "*").'));
        const unknown = types.filter((filter) => !DELIVERABLE_TYPES.some((type) => typeMatches(filter, type)));
        if (unknown.length > 0) throw bad(fill(tr('보낼 수 있는 이벤트 종류가 아닙니다: {0}'), { 0: unknown.join(', ') }));
        input.types = types;
        break;
      }
      case 'packageIds':
        input.packageIds = stringList(value, 'packageIds');
        break;
      case 'enabled':
        if (typeof value !== 'boolean') throw bad(tr('enabled는 true 또는 false여야 합니다.'));
        input.enabled = value;
        break;
      case 'options':
        input.options = options(value);
        break;
    }
  }
  if (mode === 'create') {
    for (const required of ['name', 'kind', 'url', 'types'] as const) {
      if (input[required] === undefined) throw bad(fill(tr('{0}이(가) 없습니다.'), { 0: required }));
    }
  }
  return input;
}

/**
 * Splits `mqtt://user:pass@host` into the URL without userinfo and the credentials (`user:pass`, decoded).
 * Webhook URLs with userinfo are refused instead — basic-auth in a URL ends up in logs and screenshots.
 */
export function splitCredentials(url: string, kind: SubscriptionKind): { url: string; credentials?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw bad(fill(tr('주소를 읽지 못했습니다: {0}'), { 0: url }));
  }
  if (parsed.username === '' && parsed.password === '') return { url };
  if (kind === 'webhook') throw bad(tr('웹훅 주소에는 사용자 이름이나 비밀번호를 넣을 수 없습니다.'));
  const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), credentials };
}
