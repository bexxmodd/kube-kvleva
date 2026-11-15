# The kvleva logo

<p align="center">
  <img src="kvleva.svg" alt="kvleva logo" width="128" height="128">
</p>

The logo is a K with a magnifying glass where its arms meet. The lower arm of
the K is the handle of the glass. "Kvleva" (კვლევა) is the Georgian word for
examining, researching.

## Files

All files are SVG pictures of the same drawing.

| File | Size |
|---|---|
| [`kvleva.svg`](kvleva.svg) | No size of its own. It takes the size that you give it. |
| [`kvleva-16.svg`](kvleva-16.svg) | 16 × 16 |
| [`kvleva-32.svg`](kvleva-32.svg) | 32 × 32 |
| [`kvleva-48.svg`](kvleva-48.svg) | 48 × 48 |
| [`kvleva-64.svg`](kvleva-64.svg) | 64 × 64 |
| [`kvleva-128.svg`](kvleva-128.svg) | 128 × 128 |
| [`kvleva-256.svg`](kvleva-256.svg) | 256 × 256 |
| [`kvleva-512.svg`](kvleva-512.svg) | 512 × 512 |

Use `kvleva.svg` if you can set the size yourself. Use a file with a size if
the place where you put the logo cannot set one.

## Colors

| Color | Where |
|---|---|
| `#0b111b` | The tile behind the K |
| `#56c2f0` | The stem of the K, the rim and the handle of the glass |
| `#0b6aa8` | The upper arm of the K |
| `#1a2535` | The lens |
| `#e6edf5` | The light on the lens |

The web page of kvleva uses the same colors. See
[Frontend design](../../docs/frontend.md#visual-style).

## Do not edit these files

The files in this folder are copies. The logo that the app shows is
[`web/static/img/logo.svg`](../../web/static/img/logo.svg). To change the
logo, change that file. Then run this command in the top folder of the
project:

```sh
make logo
```

The frontend tests fail while a copy is different from the logo of the app.
