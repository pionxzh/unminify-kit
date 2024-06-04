import { basename } from 'pathe'
import { arraify } from './array'
import { jscodeshiftWithParser as j, printSourceWithErrorLoc } from './jscodeshift'
import { Timing } from './timing'
import type { MaybeArray } from './array'
import type { TransformationRule } from './rule'
import type { Collection } from 'jscodeshift'

export async function executeTransformationRules<P extends Record<string, any>>(
    /** The source code */
    source: string,
    /** The file path */
    filePath: string,
    rules: MaybeArray<TransformationRule>,
    params: P = {} as any,
) {
    const timing = new Timing()
    /**
     * To minimizes the overhead of parsing and serializing code, we will try to
     * keep the code in jscodeshift AST format as long as possible.
     */

    let currentSource: string | null = null
    let currentRoot: Collection | null = null

    const flattenRules = arraify(rules).flatMap((rule) => {
        if (rule.type === 'rule-set') return rule.rules
        return rule
    })

    let hasError = false
    for (const rule of flattenRules) {
        switch (rule.type) {
            case 'jscodeshift': {
                try {
                    const stopMeasure = timing.startMeasure(filePath, 'jscodeshift-parse')
                    currentRoot ??= j(currentSource ?? source)
                    stopMeasure()
                }
                catch (err: any) {
                    console.error(`\nFailed to parse rule ${filePath} with jscodeshift in rule ${rule.id}`, err)
                    printSourceWithErrorLoc(err, currentSource ?? source)

                    hasError = true
                    break
                }

                const stopMeasure = timing.startMeasure(filePath, rule.id)
                // rule execute already handled error
                rule.execute({
                    root: currentRoot,
                    filename: basename(filePath),
                    params,
                })
                stopMeasure()

                currentSource = null
                break
            }
            case 'string': {
                const stopMeasure1 = timing.startMeasure(filePath, 'jscodeshift-print')
                currentSource ??= currentRoot?.toSource() ?? source
                stopMeasure1()

                try {
                    const stopMeasure2 = timing.startMeasure(filePath, rule.id)
                    currentSource = await rule.execute({
                        source: currentSource,
                        filename: filePath,
                        params,
                    }) ?? currentSource
                    stopMeasure2()
                }
                catch (err: any) {
                    console.error(`\nError running rule ${rule.id} on ${filePath}`, err)

                    hasError = true
                }
                currentRoot = null
                break
            }
            case 'ast-grep': {
                const stopMeasure1 = timing.startMeasure(filePath, 'jscodeshift-print')
                currentSource ??= currentRoot?.toSource() ?? source
                stopMeasure1()

                try {
                    const stopMeasure2 = timing.startMeasure(filePath, rule.id)
                    currentSource = rule.execute({
                        source: currentSource,
                        filename: filePath,
                        params,
                    }) ?? currentSource
                    stopMeasure2()
                }
                catch (err: any) {
                    console.error(`\nError running rule ${rule.id} on ${filePath}`, err)
                }
                currentRoot = null
                break
            }
            default: {
                throw new Error(`Unsupported rule type ${rule.type} from ${rule.id}`)
            }
        }

        // stop if there is an error to prevent further damage
        if (hasError) break
    }

    let code = currentSource as string
    try {
        code ??= currentRoot?.toSource() ?? source
    }
    catch (err) {
        console.error(`\nFailed to print code ${filePath}`, err)
    }

    return {
        path: filePath,
        code,
        timing,
    }
}
