import { createJSCodeshiftTransformationRule } from '@wakaru/shared/rule'
import type { NumericLiteral, StringLiteral } from 'jscodeshift'

/**
 * // params: { 29: 'index.js' }
 * const a = require(29)
 * ->
 * const a = require('index.js')
 */
export default createJSCodeshiftTransformationRule({
    name: 'module-mapping',
    transform: (context, params) => {
        const { root, j } = context
        const { moduleMapping = {} } = params

        root
            .find(j.CallExpression, {
                callee: {
                    type: 'Identifier',
                    name: 'require',
                },
                arguments: args => args.length === 1 && (j.StringLiteral.check(args[0]) || j.NumericLiteral.check(args[0])),
            })
            .forEach((p) => {
                const { value } = p.node.arguments[0] as StringLiteral | NumericLiteral
                const replacement = moduleMapping[value]
                if (replacement) {
                    p.node.arguments[0] = j.stringLiteral(replacement)
                }
            })
    },
})
