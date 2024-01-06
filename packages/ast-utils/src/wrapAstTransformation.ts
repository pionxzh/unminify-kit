import type { ModuleMapping, ModuleMeta } from './types'
import type { Core, JSCodeshift, Options, Transform } from 'jscodeshift'

export interface SharedParams {
    moduleMapping?: ModuleMapping
    moduleMeta?: ModuleMeta
}

export interface Context {
    root: ReturnType<Core>
    j: JSCodeshift
    filename: string
}

export interface ASTTransformation<Params = object> {
    (context: Context, params: Params & SharedParams): string | void
}

export function wrapAstTransformation<Params extends Options>(
    transformAST: ASTTransformation<Params & SharedParams>,
): Transform {
    // @ts-expect-error - jscodeshift is not happy
    const transform: Transform = (file, api, options: Params & SharedParams) => {
        const j = api.jscodeshift
        const root = j(file.source)
        const result = transformAST({ root, j, filename: file.path }, options)
        return result ?? root.toSource({ lineTerminator: '\n' })
    }

    return transform
}
