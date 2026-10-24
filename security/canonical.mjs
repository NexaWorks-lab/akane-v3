// G1 security：正規化JSON（GASの 09_Utils.gs akane_utilsCanonicalJson_ / ParseJson_ / ParseCanonicalJson_ と同じ規則）
//
// 許可：null・真偽値・文字列（不正なサロゲートは拒否）・安全な整数（-0 は拒否）・穴のない配列・
//       プレーンなオブジェクト（キーは英数と _ . - だけ。__proto__・prototype・constructor は拒否）
// 出力：キーを並べ替え、空白なし。文字列と数値は JSON.stringify と同じ表記。
// エラーは09と同じコードの Error を投げる。
//
// 09の規則を変えるときは、このファイルと security/vectors.json を同時に直し、
// GAS側（99の akane_testG1Vectors）と GitHub側（security/test.mjs）の両方で一致を確かめること。

export function canonicalJson(value) {
  const ancestors = [];

  function cleanUnicode(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);

      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = s.charCodeAt(++i);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) {
          throw new Error('AKANE_INVALID_UNICODE');
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        throw new Error('AKANE_INVALID_UNICODE');
      }
    }
    return s;
  }

  function visit(item) {
    if (item === null) {
      return 'null';
    }

    if (typeof item === 'string') {
      return JSON.stringify(cleanUnicode(item));
    }

    if (typeof item === 'boolean') {
      return JSON.stringify(item);
    }

    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) {
        throw new Error('AKANE_INVALID_JSON_NUMBER');
      }
      return JSON.stringify(item);
    }

    if (typeof item !== 'object') {
      throw new Error('AKANE_INVALID_JSON_TYPE');
    }

    if (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null) {
      throw new Error('AKANE_INVALID_JSON_OBJECT');
    }

    if (ancestors.indexOf(item) >= 0) {
      throw new Error('AKANE_CIRCULAR_JSON');
    }

    ancestors.push(item);

    try {
      if (Array.isArray(item)) {
        const parts = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(item, i)) {
            throw new Error('AKANE_INVALID_JSON_ARRAY');
          }
          parts.push(visit(item[i]));
        }
        return '[' + parts.join(',') + ']';
      }

      const keys = Object.keys(item).sort();
      const entries = keys.map((key) => {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor' ||
            !/^[A-Za-z0-9_.-]+$/.test(key)) {
          throw new Error('AKANE_INVALID_JSON_KEY');
        }
        return JSON.stringify(key) + ':' + visit(item[key]);
      });

      return '{' + entries.join(',') + '}';
    } finally {
      ancestors.pop();
    }
  }

  return visit(value);
}

export function parseJson(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('AKANE_INVALID_JSON_INPUT');
  }

  let result;

  try {
    result = JSON.parse(source);
  } catch (e) {
    throw new Error('AKANE_JSON_PARSE_FAILED');
  }

  canonicalJson(result);
  return result;
}

export function parseCanonicalJson(source) {
  const data = parseJson(source);

  if (canonicalJson(data) !== source) {
    throw new Error('AKANE_JSON_NOT_CANONICAL');
  }

  return data;
}
