import { mergeComments } from './comments'
import { findReferences } from './reference'
import type { Scope } from 'ast-types/lib/scope'
import type { ASTPath, Collection, Identifier, ImportDeclaration, JSCodeshift, Statement, VariableDeclaration } from 'jscodeshift'

export function isDeclared(scope: Scope | null, name: string) {
    while (scope) {
        if (scope.declares(name)) return true
        scope = scope.parent
    }

    return false
}

export function findDeclaration(scope: Scope, name: string): ASTPath<Identifier> | undefined {
    return scope.lookup(name)?.getBindings()[name]?.[0]
}

export function findDeclarations(j: JSCodeshift, scope: Scope, name: string): Collection<Identifier> {
    return j(scope.lookup(name)?.getBindings()[name] ?? [])
}

export function removeDeclarationIfUnused(j: JSCodeshift, path: ASTPath, name: string) {
    const scope = path.scope?.lookup(name)
    if (!scope) return

    const idsUsedInScope = findReferences(j, scope, name)
    const idsUsedInPath = j(path).find(j.Identifier, { name })
    const idsUsed = idsUsedInScope.length - idsUsedInPath.length
    if (idsUsed === 1) {
        removeVariableDeclarator(j, idsUsedInScope.get())
    }
}

/**
 * Removes a variable declarator based on the given identifier path.
 * The variable declaration is removed if it has no other declarators.
 */
export function removeVariableDeclarator(j: JSCodeshift, path: ASTPath<Identifier>) {
    if (!(j.VariableDeclarator.check(path.parent.node) && j.VariableDeclaration.check(path.parent.parent.node))) return

    const vDeclarationPath = path.parent.parent
    const vDeclaration = vDeclarationPath.node as VariableDeclaration
    const index = vDeclaration.declarations.findIndex(declarator => j.VariableDeclarator.check(declarator)
        && j.Identifier.check(declarator.id)
        && declarator.id === path.node,
    )
    if (index > -1) {
        vDeclaration.declarations.splice(index, 1)

        if (vDeclaration.declarations.length === 0) {
            const body = vDeclarationPath.parent.node?.body as Statement[] | undefined
            if (Array.isArray(body)) {
                const currentNodeIndex = body.findIndex(child => child === vDeclarationPath.node)
                if (currentNodeIndex > -1) {
                    const nextSibling = body[currentNodeIndex + 1]
                    if (nextSibling) {
                        mergeComments(nextSibling, vDeclarationPath.node.comments)
                    }

                    if (j.BlockStatement.check(vDeclarationPath.parent.node)) {
                        // FIXME: prune() will fail if the parent is a BlockStatement
                        // and I have no idea why
                        body.splice(currentNodeIndex, 1)
                        return
                    }
                }
            }

            vDeclarationPath.prune()
        }
    }
}

export function removeDefaultImportIfUnused(j: JSCodeshift, root: Collection, local: string) {
    const idsUsed = root.find(j.Identifier, { name: local })
    if (idsUsed.size() !== 1) return

    const idUsed = idsUsed.paths()[0]
    if (j.ImportDefaultSpecifier.check(idUsed.parent.node) && j.ImportDeclaration.check(idUsed.parent.parent.node)) {
        const importDeclaration = idUsed.parent.parent.node as ImportDeclaration
        if (!importDeclaration.specifiers) return
        const index = importDeclaration.specifiers.findIndex(declarator => j.ImportDefaultSpecifier.check(declarator)
            && j.Identifier.check(declarator.local)
            && declarator.local === idUsed.node,
        )
        if (index > -1) {
            importDeclaration.specifiers.splice(index, 1)
            if (importDeclaration.specifiers.length === 0) {
                mergeComments(importDeclaration, idUsed.parent.parent.value.comments)
                idUsed.parent.parent.prune()
            }
        }
    }
}
