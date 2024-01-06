import path from 'node:path'
import process from 'node:process'
import { Timing } from '@wakaru/shared/timing'
import { unpack } from '@wakaru/unpacker'
import fsa from 'fs-extra'
import type { ModuleMapping } from '@wakaru/ast-utils/types'
import type { Module } from '@wakaru/unpacker'

export interface UnpackerItem {
    files: string[]
    modules: Module[]
    moduleIdMapping: ModuleMapping
}

export async function unpacker(
    paths: string[],
    outputDir: string,
): Promise<{ items: UnpackerItem[]; timing: Timing }> {
    fsa.ensureDirSync(outputDir)

    const items: UnpackerItem[] = []
    const files: string[] = []

    const cwd = process.cwd()
    const timing = new Timing()

    for (const p of paths) {
        const source = await fsa.readFile(p, 'utf-8')

        const stopMeasure = timing.startMeasure(path.relative(cwd, p), 'unpacker')
        const { modules, moduleIdMapping } = unpack(source)
        stopMeasure()

        for (const mod of modules) {
            const filename = moduleIdMapping[mod.id] ?? `module-${mod.id}.js`
            const outputPath = path.join(outputDir, filename)
            await fsa.ensureFile(outputPath)
            await fsa.writeFile(outputPath, mod.code, 'utf-8')
            files.push(outputPath)
        }

        items.push({
            files,
            modules,
            moduleIdMapping,
        })
    }
    return { items, timing }
}
