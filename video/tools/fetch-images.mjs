/**
 * Fetch the promo's one photo, with its licence, from Wikimedia Commons.
 *
 * Commons is the source because of one property no other free image host has: it serves a
 * plain HTTP API without a key **and** returns the licence and the author in the same
 * response. Unsplash refuses both — `unsplash.com/napi/search/photos` answers **401** and so
 * does the search page's HTML — so a script cannot fetch the bytes and prove the licence from
 * there. Many of Unsplash's own CC0 photos are re-hosted on Commons with that metadata
 * attached, which is what makes this workable.
 *
 * Only the file S2 actually renders is kept. `scenes/data/img/credits.json` is the record
 * that travels with it; regenerate it with this script for a different photo.
 *
 * Usage:
 *   node tools/fetch-images.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'scenes', 'data', 'img')
const API = 'https://commons.wikimedia.org/w/api.php'
const UA = 'dsh-superboard-promo/0.1 (local render)'

/** The photo S2 uses: a laptop showing a dashboard, so it reads as a page that was looked at. */
const TITLES = ['File:Statistics on a laptop (Unsplash).jpg']

mkdirSync(OUT, { recursive: true })

const credits = []
for (const [index, title] of TITLES.entries()) {
  const url = `${API}?action=query&titles=${encodeURIComponent(title)}`
    + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1000&format=json'
  const body = await (await fetch(url, { headers: { 'User-Agent': UA } })).json()
  const info = Object.values(body.query.pages)[0].imageinfo?.[0]
  if (info === undefined) throw new Error(`no imageinfo for ${title}`)

  const meta = info.extmetadata
  const file = `shot-${index + 5}.jpg`
  const bytes = new Uint8Array(
    await (await fetch(info.thumburl, { headers: { 'User-Agent': UA } })).arrayBuffer(),
  )
  writeFileSync(join(OUT, file), bytes)

  const strip = (value) => (value ?? '').replace(/<[^>]*>/g, '').trim()
  credits.push({
    file,
    title: title.replace(/^File:/, ''),
    licence: meta.LicenseShortName?.value ?? 'unknown',
    author: strip(meta.Artist?.value),
    credit: strip(meta.Credit?.value).slice(0, 120),
    descriptionUrl: info.descriptionurl,
    width: info.thumbwidth,
    height: info.thumbheight,
    bytes: bytes.length,
  })
  console.log(`${file}  ${credits.at(-1).licence}  ${info.thumbwidth}x${info.thumbheight}  ${bytes.length} bytes`)
}

writeFileSync(join(OUT, 'credits.json'), JSON.stringify(credits, null, 2) + '\n')
console.log(`\n${credits.length} file(s) + credits.json → ${OUT}`)
