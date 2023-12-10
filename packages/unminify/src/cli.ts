#!/usr/bin/env node

/* eslint-disable no-console */
import * as path from 'node:path'
import process, { hrtime } from 'node:process'
import fsa from 'fs-extra'
import * as globby from 'globby'
import c from 'picocolors'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { version } from '../package.json'
import { TransformationRule } from './transformations'
import { runTransformations, transformationRules } from '.'
import type { Transform } from 'jscodeshift'

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silent'

interface TimingStat {
    filename: string
    /**
     * Timing measurement key
     */
    key: string
    /**
     * Time in milliseconds
     */
    time: number
}

class Timing {
    private collected: TimingStat[] = []

    constructor(private enabled: boolean) { }

    /**
     * Collect a timing measurement
     */
    collect<T>(filename: string, key: string, fn: () => T): T {
        if (!this.enabled) return fn()

        const { result, time } = this.measureTime(fn)
        this.collected.push({ filename, key, time })

        return result
    }

    /**
     * Collect a timing measurement
     */
    async collectAsync<T>(filename: string, key: string, fn: () => T): Promise<T> {
        if (!this.enabled) return fn()

        const { result, time } = await this.measureTimeAsync(fn)
        this.collected.push({ filename, key, time })

        return result
    }

    /**
     * Measure the time it takes to execute a function
     */
    measureTime<T>(fn: () => T) {
        const start = hrtime()
        const result = fn()
        const end = hrtime(start)
        const time = end[0] * 1e3 + end[1] / 1e6

        return { result, time }
    }

    /**
     * Measure the time it takes to execute a async function
     */
    async measureTimeAsync<T>(fn: () => T) {
        const start = hrtime()
        const result = await fn()
        const end = hrtime(start)
        const time = end[0] * 1e3 + end[1] / 1e6

        return { result, time }
    }
}

// eslint-disable-next-line no-unused-expressions
yargs(hideBin(process.argv))
    .scriptName('@wakaru/unminify')

    .option('log-level', {
        type: 'string',
        default: 'info',
        choices: ['error', 'warn', 'info', 'debug', 'silent'],
        describe: 'change the level of logging for the CLI.',
    })

    .help()
    .showHelpOnFail(true)
    .alias('h', 'help')

    .version('version', version)
    .alias('v', 'version')

    .usage('Usage: $0 <files...> [options]')
    .command(
        '* <files...>',
        'Unminify your bundled code',
        args => args

            .option('output', {
                alias: 'o',
                describe: 'specify the output directory (default: out/)',
                type: 'string',
                default: 'out/',
            })
            .option('force', {
                alias: 'f',
                describe: 'force overwrite output directory',
                type: 'boolean',
                default: false,
            })
            .option('perf', {
                describe: 'enable performance statistics',
                type: 'boolean',
                default: false,
            })
            .positional('files', {
                describe: 'File paths to process (supports glob patterns)',
                type: 'string',
                array: true,
            })
            .help(),
        async (args) => {
            await codemod(
                args.files ?? [],
                args.output,
                args.force,
                args.logLevel as LogLevel,
                args.perf,
            )
        },
    )
    .argv

async function codemod(
    paths: string[],
    output: string,
    force: boolean,
    logLevel: LogLevel,
    perf: boolean,
) {
    const cwd = process.cwd()
    const globbyPaths = paths
        .map(p => path.normalize(p))
        .map(p => p.replace(/\\/g, '/'))
    const resolvedPaths = await globby.default(globbyPaths, {
        cwd,
        absolute: true,
        ignore: [path.join(cwd, '**/node_modules/**')],
    })

    // Check if any paths are outside of the current working directory
    for (const p of resolvedPaths) {
        if (!isPathInside(cwd, p)) {
            throw new Error(`File path ${c.green(path.relative(cwd, p))} is outside of the current working directory. This is not allowed.`)
        }
    }

    const outputDir = path.resolve(cwd, output)
    if (await fsa.exists(outputDir)) {
        if (!force) {
            throw new Error(`Output directory already exists at ${c.green(path.relative(cwd, outputDir))}. Pass ${c.yellow('--force')} to overwrite.`)
        }
    }
    await fsa.ensureDir(outputDir)

    const commonBaseDir = findCommonBaseDir(resolvedPaths)
    if (!commonBaseDir) throw new Error('Could not find common base directory')

    const timing = new Timing(perf)

    for (const p of resolvedPaths) {
        const outputPath = path.join(outputDir, path.relative(commonBaseDir, p))
        await fsa.ensureDir(path.dirname(outputPath))

        const filename = path.relative(cwd, outputPath)
        const measure = <T>(key: string, fn: () => T) => timing.collect(filename, key, fn)
        const measureAsync = <T>(key: string, fn: () => Promise<T>) => timing.collectAsync(filename, key, fn)

        const { time: elapsed } = await timing.measureTimeAsync(async () => {
            const source = await measureAsync('read file', () => fsa.readFile(p, 'utf-8'))

            const transformations = transformationRules.map<Transform>((rule) => {
                const { id, transform } = rule
                return (...args: Parameters<Transform>) => measure(id, () => transform(...args))
            })
            const result = measure('runDefaultTransformation', () => runTransformations({ path: p, source }, transformations))

            await measureAsync('write file', () => fsa.writeFile(outputPath, result.code, 'utf-8'))
        })

        if (logLevel !== 'silent') {
            const formattedElapsed = (elapsed / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })
            console.log(`${c.dim('•')} Transforming ${c.green(path.relative(cwd, outputPath))} ${c.dim(`(${formattedElapsed}ms)`)}`)
        }
    }
}

/**
 * Check if base path contains target path
 */
function isPathInside(base: string, target: string): boolean {
    const relative = path.relative(base, target)
    return !relative.startsWith('..') && !path.isAbsolute(relative)
}

function findCommonBaseDir(paths: string[]): string | null {
    if (!paths.length) return null

    const absPaths = paths.map(p => path.resolve(p))
    let commonParts = absPaths[0].split(path.sep)

    for (let i = 1; i < absPaths.length; i++) {
        const parts = absPaths[i].split(path.sep)
        for (let j = 0; j < commonParts.length; j++) {
            if (commonParts[j] !== parts[j]) {
                commonParts = commonParts.slice(0, j)
                break
            }
        }
    }

    const commonPath = commonParts.join(path.sep)
    // if path is not a directory, use its parent directory
    return fsa.statSync(commonPath).isDirectory()
        ? commonPath
        : path.dirname(commonPath)
}
