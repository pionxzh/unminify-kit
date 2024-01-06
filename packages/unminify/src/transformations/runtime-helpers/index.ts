import { createJSCodeshiftTransformationRule } from '@wakaru/shared/rule'
import { transformAST as arrayLikeToArray } from './babel/arrayLikeToArray'
import { transformAST as arrayWithoutHoles } from './babel/arrayWithoutHoles'
import { transformAST as createForOfIteratorHelper } from './babel/createForOfIteratorHelper'
import { transformAST as _extends } from './babel/extends'
import { transformAST as objectSpread } from './babel/objectSpread'
import { transformAST as slicedToArray } from './babel/slicedToArray'
import { transformAST as toConsumableArray } from './babel/toConsumableArray'
import type { ASTTransformation } from '@wakaru/shared/rule'

export const transformAST: ASTTransformation = (context, params) => {
    // babel helpers
    arrayLikeToArray(context, params)
    arrayWithoutHoles(context, params)
    toConsumableArray(context, params)
    slicedToArray(context, params)
    _extends(context, params)
    objectSpread(context, params)
    createForOfIteratorHelper(context, params)
}

export default createJSCodeshiftTransformationRule({
    name: 'runtime-helpers',
    transform: transformAST,
})
