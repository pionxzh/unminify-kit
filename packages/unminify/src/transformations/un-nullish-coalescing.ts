import { areNodesEqual, isNotNullBinary, isNull, isNullBinary, isUndefined, isUndefinedBinary } from '../utils/checker'
import { mergeComments } from '../utils/comments'
import { negateCondition } from '../utils/condition'
import { isDecisionTreeLeaf, makeDecisionTree, makeDecisionTreeWithConditionSplitting, negateDecisionTree } from '../utils/decisionTree'
import { smartParenthesized } from '../utils/parenthesized'
import { removeDeclarationIfUnused } from '../utils/scope'
import wrap from '../wrapAstTransformation'
import type { DecisionTree } from '../utils/decisionTree'
import type { ASTTransformation } from '../wrapAstTransformation'
import type { ExpressionKind } from 'ast-types/lib/gen/kinds'
import type { ASTPath, ConditionalExpression, JSCodeshift, LogicalExpression } from 'jscodeshift'

/**
 * Restore nullish coalescing syntax.
 *
 * TODO: Nullish_coalescing_assignment ??=
 *
 * Only support `loose=false` mode.
 */
export const transformAST: ASTTransformation = (context) => {
    const { root, j } = context

    const visited = new Set<ASTPath>()

    let passes = 5
    while (passes--) {
        root
            .find(j.ConditionalExpression)
            .forEach((path) => {
                if (visited.has(path)) return
                visited.add(path)

                const result = convertOptionalChaining(j, path)
                if (result) {
                    path.replace(result)
                }
            })

        root
            .find(j.LogicalExpression, { operator: (op: LogicalExpression['operator']) => op === '&&' || op === '||' })
            .forEach((path) => {
                if (visited.has(path)) return
                visited.add(path)

                const result = convertOptionalChaining(j, path)
                if (result) {
                    path.replace(result)
                }
            })
    }
}

function convertOptionalChaining(j: JSCodeshift, path: ASTPath<ConditionalExpression | LogicalExpression>): ExpressionKind | null {
    // console.log('\n\n>>>', `${picocolors.green(j(expression).toSource())}`)

    const expression = path.node
    const _decisionTree = makeDecisionTreeWithConditionSplitting(j, makeDecisionTree(j, expression))
    const shouldNegate = isNotNullBinary(j, _decisionTree.condition)
    const decisionTree = shouldNegate
        ? negateDecisionTree(j, _decisionTree)
        : _decisionTree
    // renderDebugDecisionTree(j, decisionTree)

    const result = constructNullishCoalescing(j, path, decisionTree, 0, shouldNegate)
    if (result) {
        mergeComments(result, expression.comments)
        // console.log('<<<', `${picocolors.cyan(j(result).toSource())}`)
    }
    return result
}

function constructNullishCoalescing(
    j: JSCodeshift,
    path: ASTPath<ConditionalExpression | LogicalExpression>,
    tree: DecisionTree,
    flag: 0 | 1,
    isNegated: boolean,
): ExpressionKind | null {
    const { condition, trueBranch, falseBranch } = tree

    /**
     * Flag 0: Default state, looking for null
     * Flag 1: Null detected, looking for undefined
     */
    if (flag === 0) {
        if (!falseBranch) return null
        if (!isFalsyBranch(j, trueBranch)) return null

        if (isNullBinary(j, condition)) {
            const { left, right: _ } = condition
            const cond = constructNullishCoalescing(j, path, falseBranch, 1, isNegated)
            if (!cond) return null
            if (j.AssignmentExpression.check(left) && j.Identifier.check(left.left)) {
                const nestedAssignment = j(left).find(j.AssignmentExpression, { left: { type: 'Identifier' } }).nodes()
                const allAssignment = [left, ...nestedAssignment]
                const result = allAssignment.reduce((acc, curr) => {
                    const { left: tempVariable, right: originalVariable } = curr
                    return variableReplacing(j, acc, tempVariable as ExpressionKind, originalVariable)
                }, cond)

                allAssignment.forEach((assignment) => {
                    const { left: tempVariable } = assignment
                    if (j.Identifier.check(tempVariable)) {
                        removeDeclarationIfUnused(j, path, tempVariable.name)
                    }
                })

                return result
            }
            else {
                return variableReplacing(j, cond, left)
            }
        }
    }
    else if (flag === 1) {
        if (!falseBranch) return null

        if (isUndefinedBinary(j, condition)) {
            if (!isFalsyBranch(j, trueBranch)) {
                if (trueBranch && isDecisionTreeLeaf(trueBranch) && isDecisionTreeLeaf(falseBranch)) {
                    const nullishCoalescing = j.logicalExpression(
                        '??',
                        isNegated ? negateCondition(j, falseBranch.condition) : falseBranch.condition,
                        isNegated ? negateCondition(j, trueBranch.condition) : trueBranch.condition,
                    )
                    return nullishCoalescing
                }
                return null
            }
            return constructNullishCoalescing(j, path, falseBranch, 0, isNegated)
        }
        return null
    }

    return null
}

function variableReplacing<T extends ExpressionKind>(
    j: JSCodeshift,
    node: T,
    tempVariable: ExpressionKind,
    targetExpression?: ExpressionKind,
): T {
    // console.log('variableReplacing', node.type, j(node).toSource(), '|', tempVariable ? j(tempVariable).toSource() : null, '|', targetExpression ? j(targetExpression).toSource() : null)

    if (j.LogicalExpression.check(node)) {
        node.left = variableReplacing(j, node.left, tempVariable, targetExpression)
        node.right = variableReplacing(j, node.right, tempVariable, targetExpression)
    }

    if (j.MemberExpression.check(node)) {
        if (areNodesEqual(j, node.object, tempVariable)) {
            /**
             * Wrap with parenthesis to ensure the precedence.
             * The output will be a little bit ugly, but it
             * will eventually be cleaned up by prettier.
             */
            const object = targetExpression
                ? smartParenthesized(j, targetExpression)
                : node.object
            return j.memberExpression(object, node.property, node.computed) as T
        }

        node.object = variableReplacing(j, node.object, tempVariable, targetExpression)
    }

    if (j.AssignmentExpression.check(node)) {
        if (areNodesEqual(j, node.left, tempVariable) && targetExpression) {
            if (node.right === targetExpression) {
                return targetExpression as T
            }
            node.left = targetExpression as any
        }
    }

    if (j.Identifier.check(node) && areNodesEqual(j, node, tempVariable) && targetExpression) {
        return targetExpression as T
    }

    if (j.UnaryExpression.check(node)) {
        node.argument = variableReplacing(j, node.argument, tempVariable, targetExpression)
    }

    return node
}

function isFalsyBranch(j: JSCodeshift, tree: DecisionTree | null): boolean {
    if (!tree) return true

    const { condition, trueBranch, falseBranch } = tree

    return (isNull(j, condition) || isUndefined(j, condition))
        && (!trueBranch || isFalsyBranch(j, trueBranch))
        && (!falseBranch || isFalsyBranch(j, falseBranch))
}

export default wrap(transformAST)
