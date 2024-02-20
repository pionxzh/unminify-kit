import { defineInlineTest } from '@wakaru/test-utils'
import transform from '../smart-inline'

const inlineTest = defineInlineTest(transform)

inlineTest('inline temp variable assignment',
  `
const t = e;
const n = t;

const o = 1;
const r = o;
const g = r;
`,
  `
const n = e;
const g = 1;
`,
)

inlineTest('inline temp variable assignment - comments',
  `
// comment
const o = 1;
// comment2
const r = o;
// comment3
const g = r;
`,
  `
// comment
// comment2
// comment3
const g = 1;
`,
)

inlineTest('inline temp variable assignment - should not inline if used more than once',
  `
const t = e;
const n = t;
const o = t;
`,
  `
const t = e;
const n = t;
const o = t;
`,
)

inlineTest('property destructuring',
  `
const t = e.x;
const n = e.y;
const r = e.color;
e.type;
console.log(t, n, r);
`,
  `
const {
  x,
  y,
  color,
  type
} = e;

console.log(x, y, color);
`,
)

inlineTest('property destructuring - comments',
  `
// comment
const t = e.x;
// comment2
const n = e.y;
// comment3
const r = e.color;
e.type;
console.log(t, n, r);
`,
  `
// comment
// comment2
// comment3
const {
  x,
  y,
  color,
  type
} = e;

console.log(x, y, color);
`,
)

inlineTest('property destructuring - with string literal and invalid identifier',
  `
const t = e['color'];
const n = e['2d'];
e['type'];
console.log(t, n);
`,
  `
const {
  color,
  "2d": _2d,
  type
} = e;

console.log(color, _2d);
`,
)

inlineTest('property destructuring - with temp variable inlined',
  `
const e = source;
const t = e.x;
const n = e.y;
const r = e.color;
e.type;
console.log(t, n, r);
`,
  `
const {
  x,
  y,
  color,
  type
} = source;

console.log(x, y, color);
`,
)

inlineTest('property destructuring - duplicate properties',
  `
const t = e.size;
const n = e.size;
const r = e.color;
const g = e.color;

console.log(t, n, r, g);
`,
  `
const {
  size,
  color
} = e;

console.log(size, size, color, color);
`,
)

inlineTest('property destructuring - preserve lonely property access',
  `
unused.prop;
unused['prop'];
`,
  `
unused.prop;
unused['prop'];
`,
)

inlineTest('property destructuring - resolve naming conflicts',
  `
const n = e.size;
const r = e.color;

const t = f.size;
const g = f.color;

console.log(n, r, t, g);
`,
  `
const {
  size,
  color
} = e;

const {
  size: size_1,
  color: color_1
} = f;

console.log(size, color, size_1, color_1);
`,
)

inlineTest('property destructuring - resolve naming conflicts #2',
  `
var u = r.tag;
if (3 === u) {
  for (u = r.return; null !== u; ) {
    var i = u.tag;
    if (3 === i) {
      u = u.return;
    }
  }
}
`,
  `
var {
  tag
} = r;
if (3 === tag) {
  for (tag = r.return; null !== tag; ) {
    var {
      tag: tag_1
    } = tag;
    if (3 === tag_1) {
      tag = tag.return;
    }
  }
}
`,
)

inlineTest('property destructuring - resolve naming conflicts #3',
  `
function foo() {
  var u = r.tag;
  if (3 === u) {
    for (u = r.return; null !== u; ) {
      var i = u.tag;
      if (3 === i) {
        u = u.return;
      }
    }
  }
}
`,
  `
function foo() {
  var {
    tag
  } = r;
  if (3 === tag) {
    for (tag = r.return; null !== tag; ) {
      var {
        tag: tag_1
      } = tag;
      if (3 === tag_1) {
        tag = tag.return;
      }
    }
  }
}
`,
)

inlineTest('property destructuring - consecutive assignments',
  `
const t = s.target;
const p = t.parentElement;
const v = p.value;
`,
  `
const {
  target
} = s;
const {
  parentElement
} = target;
const {
  value
} = parentElement;
`,
)

inlineTest('array destructuring',
  `
const t = e[0];
const n = e[1];
const r = e[2];
console.log(t, n, r);
`,
  `
const [t, n, r] = e;
console.log(t, n, r);
`,
)

inlineTest('array destructuring - comments',
  `
// comment
const t = e[0];
// comment2
const n = e[1];
// comment3
const r = e[2];
console.log(t, n, r);
`,
  `
// comment
// comment2
// comment3
const [t, n, r] = e;

console.log(t, n, r);
`,
)

inlineTest('array destructuring - with temp variable inlined',
  `
const e = source;
const t = e[0];
const n = e[1];
const r = e[2];
console.log(t, n, r);
`,
  `
const [t, n, r] = source;
console.log(t, n, r);
`,
)

inlineTest('array destructuring - with gaps',
  `
const t = e[0];
const n = e[2];
const r = e[4];
const g = e[99];
console.log(t, n, r, g);
`,
  `
const [t,, n,, r] = e;
const g = e[99];
console.log(t, n, r, g);
`,
)

inlineTest('array destructuring - not starting from 0',
  `
const t = e[1];
const n = e[2];
console.log(t, n);
`,
  `
const [, t, n] = e;
console.log(t, n);
`,
)

inlineTest('mixed destructuring - var',
  `
var _expr = expr;
var x1 = _expr[0];
var _expr$ = _expr[1];
var x2 = _expr$.key;
var x3 = _expr$.value;

console.log(x1, x2, x3);
`,
  `
var _expr = expr;
var [x1, _expr$] = _expr;

var {
  key,
  value
} = _expr$;

console.log(x1, key, value);
`,
)

inlineTest('mixed destructuring - let',
  `
let _expr = expr;
let x1 = _expr[0];
let _expr$ = _expr[1];
let x2 = _expr$.key;
let x3 = _expr$.value;

x3 += 1;

console.log(x1, x2, x3);
`,
  `
let _expr = expr;
let [x1, _expr$] = _expr;

let {
  key,
  value
} = _expr$;

value += 1;

console.log(x1, key, value);
`,
)
