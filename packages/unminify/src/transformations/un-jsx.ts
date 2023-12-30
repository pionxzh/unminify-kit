import { assertScopeExists } from '@wakaru/ast-utils/assert'
import { pascalCase } from '@wakaru/ast-utils/case'
import { removePureAnnotation } from '@wakaru/ast-utils/comments'
import { generateName } from '@wakaru/ast-utils/identifier'
import { insertBefore } from '@wakaru/ast-utils/insert'
import { isNull, isTrue, isUndefined } from '@wakaru/ast-utils/matchers'
import { wrapAstTransformation } from '@wakaru/ast-utils/wrapAstTransformation'
import { z } from 'zod'
import { nonNullable } from '../utils/utils'
import type { ASTTransformation } from '@wakaru/ast-utils/wrapAstTransformation'
import type { ExpressionKind, LiteralKind } from 'ast-types/lib/gen/kinds'
import type { ASTNode, ASTPath, CallExpression, Collection, Identifier, JSCodeshift, JSXAttribute, JSXElement, JSXExpressionContainer, JSXFragment, JSXIdentifier, JSXMemberExpression, JSXSpreadAttribute, JSXSpreadChild, JSXText, MemberExpression, RestElement, SpreadElement, StringLiteral, VariableDeclarator } from 'jscodeshift'

export const Schema = z.object({
    pragma: z.string().optional().describe('The pragma to use for JSX transformation.'),
    pragmaFrag: z.string().optional().describe('The pragma to use for JSX fragment transformation.'),
})

type Params = z.infer<typeof Schema>

enum Runtime {
    Classic = 'classic',
    Automatic = 'automatic',
}

/**
 * - createElement(type, props, ...children)
 * - jsx(type, props with children, key?)
 * - jsxs(type, props without children, key?)
 * - jsxDEV(type, props with children, key, isStaticChildren, __source, __self)
 */
const DEFAULT_PRAGMA_CANDIDATES = [
    'createElement', // runtime = "classic" (`React.createElement`)
    'jsx', // runtime = "automatic" (`jsxRuntime.jsx`)
    'jsxs', // runtime = "automatic" (`jsxRuntime.jsxs`)
    '_jsx', // `import { jsx as _jsx } from 'react/jsx-runtime'`
    '_jsxs', // `import { jsxs as _jsxs } from 'react/jsx-runtime'`
    'jsxDEV', // runtime = "automatic" (`jsxRuntime.jsxDEV`) (dev only)
    'jsxsDEV', // runtime = "automatic" (`jsxRuntime.jsxsDEV`) (dev only)
    'h', // Preact
]

const DEFAULT_PRAGMA_FRAG_CANDIDATES = [
    'Fragment', // React
]

// /**
//  * Meta props injected by bundlers like Babel.
//  *
//  * These props will be removed to improve readability.
//  */
// const META_PROPS = [
//     // dev only props for React to generate warnings
//     // https://github.com/babel/babel/blob/main/packages/babel-plugin-transform-react-jsx-self/src/index.ts
//     '__self',
//     // dev only props for React to add {fileName, lineNumber, columnNumber} annotations
//     // https://github.com/babel/babel/blob/main/packages/babel-plugin-transform-react-jsx-source/src/index.ts
//     '__source',
// ]

/**
 * Converts `React.createElement` and `jsxRuntime.jsx` back to JSX.
 */
export const transformAST: ASTTransformation<Params> = (context, params) => {
    Schema.parse(params)

    const { root, j } = context

    let pragmas = DEFAULT_PRAGMA_CANDIDATES
    if (params.pragma) {
        if (params.pragma.includes('.')) {
            // React.createElement -> createElement
            const [_object, property] = params.pragma.split('.')
            pragmas = [property]
        }
        else {
            pragmas = [params.pragma]
        }
    }

    let pragmaFrags = DEFAULT_PRAGMA_FRAG_CANDIDATES
    if (params.pragmaFrag) {
        if (params.pragmaFrag.includes('.')) {
            // React.Fragment -> Fragment
            const [_object, property] = params.pragmaFrag.split('.')
            pragmaFrags = [property]
        }
        else {
            pragmaFrags = [params.pragmaFrag]
        }
    }

    renameComponentBasedOnDisplayName(j, root, pragmas)

    renameComponentToMakeItValid(j, root, pragmas)

    root
        .find(j.CallExpression, {
            callee: (callee: CallExpression['callee']) => !!getPragma(j, callee, pragmas),
        })
        .paths()
        // bottom-up transformation
        .reverse()
        .forEach((path) => {
            const jsxElement = toJSX(j, path, pragmas, pragmaFrags)
            if (jsxElement) {
                const parentWithComments = j.ExpressionStatement.check(path.parent.node) ? path.parent : path
                removePureAnnotation(j, parentWithComments.node)

                path.replace(jsxElement)
            }
        })
}

function toJSX(j: JSCodeshift, path: ASTPath<CallExpression>, pragmas: string[], pragmaFrags: string[]): JSXElement | JSXFragment | null {
    const scope = path.scope
    assertScopeExists(scope)

    const node = path.node
    const pragma = getPragma(j, node.callee, pragmas)
    if (!pragma) return null

    const runtime = pragma === 'jsx' || pragma === 'jsxs' || pragma === '_jsx' || pragma === '_jsxs' || pragma === 'jsxDEV' || pragma === 'jsxsDEV'
        ? Runtime.Automatic
        : Runtime.Classic
    // const isDevelopment = pragma === 'jsxDEV' || pragma === 'jsxsDEV'

    const [type, props, ...childrenArgs] = node.arguments
    if (!type || !props) return null

    if (isCapitalizationInvalid(j, type)) return null

    let tag = toJsxTag(j, type)
    // If a tag cannot be converted to JSX tag, convert it to a variable
    if (!tag && !j.SpreadElement.check(type)) {
        const name = generateName('Component', scope)
        tag = j.jsxIdentifier(name)

        const variableDeclaration = j.variableDeclaration('const', [j.variableDeclarator(j.identifier(name), type)])
        insertBefore(j, path, variableDeclaration)
        scope.markAsStale()
    }
    if (!tag) return null

    const attributes = toJsxAttributes(j, props)

    let children: Array<JSXExpressionContainer | JSXElement | JSXFragment | JSXText | JSXSpreadChild | LiteralKind>
    const childrenFromAttribute = attributes.find(attr => j.JSXAttribute.check(attr) && attr.name.name === 'children') as JSXAttribute | undefined
    /**
     * The third argument will be the optional `key` if runtime = "automatic"
     * if children is from attribute, assume we are using runtime = "automatic"
     *
     * @example
     * function jsx(type, props, key?) {}
     */
    if (childrenFromAttribute || runtime === Runtime.Automatic) {
        if (childrenArgs.length > 0) {
            const key = childrenArgs[0]
            // key might be void 0, this is inserted by bundlers
            if (j.SpreadElement.check(key)) return null

            if (!isUndefined(j, key)) {
                const stubKeyObject = j.objectExpression([j.objectProperty(j.identifier('key'), key)])
                const keyAttributes = toJsxAttributes(j, stubKeyObject)
                attributes.splice(0, 0, ...keyAttributes)
            }

            // Note: we simply skip all other arguments as they might be used for dev only
        }

        // Transform `children` attribute to children
        if (childrenFromAttribute) {
            attributes.splice(attributes.indexOf(childrenFromAttribute), 1)

            if (
                j.JSXExpressionContainer.check(childrenFromAttribute.value)
             && j.ArrayExpression.check(childrenFromAttribute.value.expression)
            ) {
                children = childrenFromAttribute.value.expression.elements
                    .filter(nonNullable)
                    .map(child => toJsxChild(j, child))
                    .filter(nonNullable)
            }
            else if (childrenFromAttribute.value) {
                children = [toJsxChild(j, childrenFromAttribute.value)].filter(nonNullable)
            }
        }
    }

    children ??= postProcessChildren(j, childrenArgs.map(child => toJsxChild(j, child)).filter(nonNullable))

    if (attributes.length === 0) {
        const isFrag1 = j.JSXIdentifier.check(tag) && pragmaFrags.includes(tag.name)
        const isFrag2 = j.JSXMemberExpression.check(tag) && pragmaFrags.includes(tag.property.name)
        if (isFrag1 || isFrag2) {
            return j.jsxFragment(j.jsxOpeningFragment(), j.jsxClosingFragment(), children)
        }
    }

    const openingElement = j.jsxOpeningElement(tag, attributes)
    const closingElement = j.jsxClosingElement(tag)
    const selfClosing = children.length === 0
    if (selfClosing) openingElement.selfClosing = true

    return j.jsxElement(openingElement, selfClosing ? null : closingElement, children)
}

function isCapitalizationInvalid(j: JSCodeshift, node: ASTNode) {
    if (j.StringLiteral.check(node)) return !/^[a-z]/.test(node.value)
    if (j.Identifier.check(node)) return /^[a-z]/.test(node.name)
    return false
}

function toJsxTag(j: JSCodeshift, node: SpreadElement | ExpressionKind): JSXIdentifier | JSXMemberExpression | null {
    if (j.StringLiteral.check(node)) {
        return j.jsxIdentifier(node.value)
    }
    else if (j.Identifier.check(node)) {
        return j.jsxIdentifier(node.name)
    }
    else if (j.MemberExpression.check(node)) {
        const object = toJsxTag(j, node.object)
        const property = toJsxTag(j, node.property)
        if (!object || !property) return null

        return j.jsxMemberExpression(
            object as JSXIdentifier | JSXMemberExpression,
            property as JSXIdentifier,
        )
    }

    return null
}

const canLiteralBePropString = (node: StringLiteral) => {
    return !node.extra?.raw.includes('\\') && !node.value.includes('"')
}

function toJsxAttributes(j: JSCodeshift, props: SpreadElement | ExpressionKind): Array<JSXAttribute | JSXSpreadAttribute> {
    // null means empty props
    if (isNull(j, props)) return []

    /**
     * `React.__spread` is deprecated since React v15.0.1
     * https://ru.legacy.reactjs.org/blog/2016/04/08/react-v15.0.1.html
     *
     * Copied from https://github.com/reactjs/react-codemod/blob/b34b92a1f0b8ad333efe5effb50d17d46d66588b/transforms/create-element-to-jsx.js#L30
     */
    const isReactSpread = j.CallExpression.check(props)
        && j.MemberExpression.check(props.callee)
        && j.Identifier.check(props.callee.object)
        // && props.callee.object.name === 'React'
        && j.Identifier.check(props.callee.property)
        && props.callee.property.name === '__spread'

    const isObjectAssign = j.CallExpression.check(props)
        && j.MemberExpression.check(props.callee)
        && j.Identifier.check(props.callee.object)
        && props.callee.object.name === 'Object'
        && j.Identifier.check(props.callee.property)
        && props.callee.property.name === 'assign'

    /**
     * Other spread syntax might be transformed to `__assign` or `__spread` by Babel.
     * They will be handled by other rules.
     */
    if (isReactSpread || isObjectAssign) {
        return props.arguments.map(arg => toJsxAttributes(j, arg)).flat()
    }

    if (j.ObjectExpression.check(props)) {
        return props.properties.map((prop) => {
            if (j.SpreadElement.check(prop) || j.SpreadProperty.check(prop)) {
                return j.jsxSpreadAttribute(prop.argument)
            }

            // method(a) {...} -> method={{a} => {...}}
            if (j.ObjectMethod.check(prop)) {
                if (!j.Identifier.check(prop.key)) {
                    console.warn(`[un-jsx] unsupported attribute: ${j(prop).toSource()}`)
                    return null
                }

                const name = prop.key
                const value = j.arrowFunctionExpression(prop.params, prop.body)
                return j.jsxAttribute(j.jsxIdentifier(name.name), j.jsxExpressionContainer(value))
            }

            const name = prop.key
            const value = prop.value

            if (
                j.RestElement.check(value)
             || j.PropertyPattern.check(value)
             || j.ObjectPattern.check(value)
             || j.ArrayPattern.check(value)
             || j.AssignmentPattern.check(value)
             || j.TSParameterProperty.check(value)
             || j.SpreadElement.check(value)
             || j.SpreadProperty.check(value)
             || j.SpreadElementPattern.check(value)
             || j.SpreadPropertyPattern.check(value)
            ) {
                console.warn(`[un-jsx] unsupported attribute: ${j(prop).toSource()}`)
                return null
            }

            if (prop.computed) {
                const property = j.objectProperty(name, value)
                property.computed = true
                const obj = j.objectExpression([property])
                return j.jsxSpreadAttribute(obj)
            }

            if (j.Identifier.check(name) || j.StringLiteral.check(name)) {
                const k = j.Identifier.check(name)
                    ? j.jsxIdentifier(name.name)
                    : j.jsxIdentifier(name.value)
                if (isTrue(j, value)) return j.jsxAttribute(k)

                const v = j.StringLiteral.check(value) && canLiteralBePropString(value)
                    ? value
                    : j.jsxExpressionContainer(value)
                return j.jsxAttribute(k, v)
            }

            // unsupported
            console.warn(`[un-jsx] unsupported attribute: ${j(prop).toSource()}`)
            return null
        }).filter(nonNullable)
    }

    if (j.SpreadElement.check(props) || j.SpreadProperty.check(props)) {
        return toJsxAttributes(j, props.argument)
    }

    return [j.jsxSpreadAttribute(props)]
}

function toJsxChild(j: JSCodeshift, node: RestElement | SpreadElement | ExpressionKind) {
    // Skip existing jsx nodes
    if (
        j.JSXElement.check(node)
     || j.JSXFragment.check(node)
     || j.JSXText.check(node)
     || j.JSXExpressionContainer.check(node)
     || j.JSXSpreadChild.check(node)
    ) {
        return node
    }

    // undefined is empty node
    if (isUndefined(j, node)) return null

    // null and bool are empty node
    if (j.BooleanLiteral.check(node)) return null
    if (j.NullLiteral.check(node)) return null

    // cannot handle rest element
    if (j.RestElement.check(node)) return null

    if (j.StringLiteral.check(node)) {
        const textContent = node.value
        const notEmpty = textContent !== ''
        // if contains invalid characters like {, }, <, >, \r, \n
        const needEscape = /[{}<>\r\n]/.test(textContent)
        // if contains whitespace at the beginning or end
        const needTrim = /^\s|\s$/.test(textContent)

        if (notEmpty && !needEscape && !needTrim) return j.jsxText(textContent)
    }

    if (j.SpreadElement.check(node)) {
        return j.jsxSpreadChild(node.argument)
    }

    return j.jsxExpressionContainer(node)
}

/**
 * Add text newline nodes between children so recast formats
 * one child per line instead of all children on one line.
 *
 * See: https://github.com/reactjs/react-codemod/blob/b34b92a1f0b8ad333efe5effb50d17d46d66588b/transforms/create-element-to-jsx.js#L227C7-L227C81
 */
function postProcessChildren(j: JSCodeshift, children: Array<JSXExpressionContainer | JSXElement | JSXFragment | JSXText | JSXSpreadChild | LiteralKind>) {
    const lineBreak = j.jsxText('\n')
    if (children.length > 0) {
        if (children.length === 1 && j.JSXText.check(children[0])) {
            return children
        }
        return [lineBreak, ...children.flatMap(child => [child, lineBreak])]
    }
    return children
}

/**
 * Rename component based on `displayName` property.
 *
 * We will do this before the jsx transformation because
 * the variable name might conflict with normal html tags.
 * For example, `var div = () => <span />, div.displayName = 'Foo'`.
 * The `div` will be renamed to `Foo` and cause all normal `div` tags
 * become `<Foo />`. Doing renaming before jsx transformation can
 * help us rename variables correctly. Otherwise, we have no way to
 * tell the difference between `createElement('div')` and `createElement(div)`
 * after the transformation.
 *
 * @example
 * const d = () => React.createElement('span', null)
 * d.displayName = 'Foo'
 * const e = () => React.createElement(d, null)
 * ->
 * const Foo = () => <span />
 * Foo.displayName = 'Foo'
 * const e = () => <Foo />
 */
function renameComponentBasedOnDisplayName(j: JSCodeshift, root: Collection, pragmas: string[]) {
    root
        .find(j.AssignmentExpression, {
            left: {
                type: 'MemberExpression',
                object: {
                    type: 'Identifier',
                },
                property: {
                    type: 'Identifier',
                    name: 'displayName',
                },
            },
            right: {
                type: 'StringLiteral',
            },
        })
        .forEach((path) => {
            const scope = path.scope
            if (!scope) return

            const left = path.node.left as MemberExpression
            const originalName = (left.object as Identifier).name
            // we don't want to rename if the name is long enough
            if (originalName.length > 2) return

            const right = path.node.right as StringLiteral
            const displayName = right.value as string
            const newName = generateName(displayName, scope)

            // make sure original name is a component
            const isComponent = root.find(j.VariableDeclarator, {
                id: {
                    type: 'Identifier',
                    name: originalName,
                },
                init: (init: VariableDeclarator['init']) => {
                    if (!init) return false

                    const jInit = j(init)
                    const calleeChecker = (callee: CallExpression['callee']) => {
                        if (j.Identifier.check(callee)) {
                            return pragmas.includes(callee.name)
                        }

                        if (
                            j.MemberExpression.check(callee)
                            && j.Identifier.check(callee.object)
                            && j.Identifier.check(callee.property)
                        ) {
                            return pragmas.includes(callee.property.name)
                        }
                        return false
                    }
                    return j.match(init, {
                        type: 'CallExpression',
                        // @ts-expect-error
                        callee: calleeChecker,
                    })
                    || jInit.find(j.CallExpression, {
                        callee: calleeChecker,
                    }).size() > 0
                },
            }).size() > 0
            if (!isComponent) return

            scope.rename(originalName, newName)
        })
}

/**
 * Capitalize the variable of component if it is invalid in JSX.
 */
function renameComponentToMakeItValid(j: JSCodeshift, root: Collection, pragmas: string[]) {
    root
        .find(j.CallExpression, {
            callee: (callee: CallExpression['callee']) => {
                if (j.Identifier.check(callee)) {
                    return pragmas.includes(callee.name)
                }

                if (
                    j.MemberExpression.check(callee)
                    && j.Identifier.check(callee.object)
                    && j.Identifier.check(callee.property)
                ) {
                    return pragmas.includes(callee.property.name)
                }
                return false
            },
        })
        .forEach((path) => {
            const args = path.node.arguments
            if (args.length === 0) return

            const firstArg = args[0]
            if (!j.Identifier.check(firstArg)) return

            if (isCapitalizationInvalid(j, firstArg)) {
                const originalName = firstArg.name
                const scope = path.scope?.lookup(originalName)
                if (!scope) return
                const newName = generateName(pascalCase(originalName), scope)
                scope.rename(originalName, newName)
            }
        })
}

function getPragma(j: JSCodeshift, node: ExpressionKind, pragmas: string[]): string | null {
    if (j.Identifier.check(node)) {
        return pragmas.includes(node.name) ? node.name : null
    }

    if (
        j.MemberExpression.check(node)
        && j.Identifier.check(node.object)
        && j.Identifier.check(node.property)
    ) {
        return pragmas.includes(node.property.name) ? node.property.name : null
    }

    return null
}
export default wrapAstTransformation(transformAST)
