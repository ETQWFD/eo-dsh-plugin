/**
 * Build the DSH client entry into the single-file bundle the client module
 * loader expects:
 *
 *   window.__ModuleLoader__.load({ id, factory: require => { ...; return module.exports } })
 *
 * React stays external and is resolved by DSH's shared module loader.
 */
import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'lib')
fs.mkdirSync(outDir, { recursive: true })

const rawFile = path.join(outDir, 'client.raw.cjs')
await esbuild.build({
  entryPoints: [path.join(root, 'src/client/index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  outfile: rawFile,
  legalComments: 'none',
  logLevel: 'info',
})

const raw = fs.readFileSync(rawFile, 'utf8')
const wrapped = `window.__ModuleLoader__.load({id:\`dsh-eo-assistant\`,factory:require=>{var module={exports:{}};var exports=module.exports;\n${raw}\nreturn module.exports}});\n`
fs.writeFileSync(path.join(outDir, 'client.js'), wrapped)
fs.unlinkSync(rawFile)
console.log(`wrote ${path.join(outDir, 'client.js')}`)
