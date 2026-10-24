// 試験データの中で、JSONでは書けない値（-0、NaN、循環参照など）を作る。
// GAS側（99の akane_testG1Vectors）にも同じ作り方を写してある。

export function buildSpecial(name) {
  switch (name) {
    case 'NEG_ZERO': return -0;
    case 'NAN': return NaN;
    case 'INFINITY': return Infinity;
    case 'FLOAT': return 1.5;
    case 'UNSAFE_INT': return 9007199254740992;
    case 'UNDEFINED': return undefined;
    case 'FUNCTION': return function () {};
    case 'DATE': return new Date(0);
    case 'MAP': return new Map();
    case 'SPARSE_ARRAY': { const a = [1]; a[2] = 3; return a; }
    case 'CIRCULAR': { const o = { a: 1 }; o.self = o; return o; }
    case 'KEY_SPACE': return { 'a b': 1 };
    case 'KEY_JAPANESE': return { 'キー': 1 };
    case 'KEY_EMPTY': return { '': 1 };
    case 'KEY_PROTO': return JSON.parse('{"__proto__":1}');
    case 'KEY_CONSTRUCTOR': return { constructor: 1 };
    case 'KEY_PROTOTYPE': return { prototype: 1 };
    case 'LONE_HIGH': return 'a\ud800b';
    case 'LONE_LOW': return 'a\udc00b';
    case 'REVERSED_PAIR': return '\udc00\ud800';
    case 'NESTED_UNDEFINED': return { a: [1, { b: undefined }] };
    case 'BIGINT': return BigInt(1);
    case 'SYMBOL': return Symbol('x');
    default: throw new Error('unknown special ' + name);
  }
}
