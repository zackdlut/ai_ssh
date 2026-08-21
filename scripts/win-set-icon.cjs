// electron-builder afterPack: stamp build/icon.ico into the Windows exe.
//
// `win.signAndEditExecutable` is left false so Linux/WSL builds do not need
// Wine (rcedit). resedit is a pure-JS PE resource editor.
'use strict'

const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

/** @param {import('electron-builder').AfterPackContext} context */
async function winSetIcon(context) {
  if (context.electronPlatformName !== 'win32') return

  const ResEdit = require('resedit')
  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = join(context.appOutDir, exeName)
  const iconPath = join(context.packager.projectDir, 'build', 'icon.ico')

  if (!existsSync(exePath)) {
    throw new Error(`Windows executable not found: ${exePath}`)
  }
  if (!existsSync(iconPath)) {
    throw new Error(`Windows icon not found: ${iconPath}`)
  }

  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  if (groups.length === 0) {
    throw new Error(`No icon group in ${exeName}; cannot replace the executable icon`)
  }

  const iconFile = ResEdit.Data.IconFile.from(readFileSync(iconPath))
  const icons = iconFile.icons.map((item) => item.data)
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groups[0].id,
    groups[0].lang,
    icons
  )
  res.outputResource(exe)
  writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(`stamped ${iconPath} onto ${exeName}`)
}

module.exports = winSetIcon
module.exports.default = winSetIcon
