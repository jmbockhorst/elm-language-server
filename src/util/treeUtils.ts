import { Position } from "vscode-languageserver";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { ITreeContainer } from "../forest";
import { comparePosition } from "../positionUtil";
import { Type } from "./types/typeInference";
import { IElmWorkspace } from "src/elmWorkspace";

export type NodeType =
  | "Function"
  | "FunctionParameter"
  | "TypeAlias"
  | "Type"
  | "Operator"
  | "Module"
  | "CasePattern"
  | "AnonymousFunctionParameter"
  | "UnionConstructor"
  | "FieldType"
  | "TypeVariable"
  | "Port";

const functionNameRegex = new RegExp("[a-zA-Z0-9_]+");

export interface IExposed {
  name: string;
  syntaxNode: SyntaxNode;
  type: NodeType;
  exposedUnionConstructors?: {
    name: string;
    syntaxNode: SyntaxNode;
  }[];
}

export type IExposing = Map<string, IExposed>;

export function flatMap<T, U>(
  array: T[],
  callback: (value: T, index: number, array: T[]) => U[],
): U[] {
  const flattend: U[] = [];
  for (let i = 0; i < array.length; i++) {
    const elementArray = callback(array[i], i, array);
    for (const el of elementArray) {
      flattend.push(el);
    }
  }
  return flattend;
}

export class TreeUtils {
  public static getModuleNameNode(tree: Tree): SyntaxNode | undefined {
    const moduleDeclaration:
      | SyntaxNode
      | undefined = this.findModuleDeclaration(tree);
    return moduleDeclaration?.childForFieldName("name") ?? undefined;
  }

  public static getModuleExposingListNodes(tree: Tree): SyntaxNode[] {
    const moduleNode = TreeUtils.findModuleDeclaration(tree);

    if (moduleNode) {
      return [
        ...TreeUtils.descendantsOfType(moduleNode, "exposed_value"),
        ...TreeUtils.descendantsOfType(moduleNode, "exposed_type"),
      ];
    }

    return [];
  }

  public static findFirstNamedChildOfType(
    type: string,
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    return node.children.find((child) => child.type === type);
  }

  public static findAllNamedChildrenOfType(
    type: string | string[],
    node: SyntaxNode,
  ): SyntaxNode[] | undefined {
    const result = Array.isArray(type)
      ? node.children.filter((child) => type.includes(child.type))
      : node.children.filter((child) => child.type === type);

    return result.length === 0 ? undefined : result;
  }

  public static findExposedFunctionNode(
    node: SyntaxNode,
    functionName: string,
  ): SyntaxNode | undefined {
    if (node) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        node,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return undefined;
        }
      }
      const descendants = TreeUtils.descendantsOfType(node, "exposed_value");
      return descendants.find((desc) => desc.text === functionName);
    }
  }

  public static isExposedFunction(tree: Tree, functionName: string): boolean {
    const module = this.findModuleDeclaration(tree);
    if (module) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        module,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return true;
        }
      }
      const descendants = TreeUtils.descendantsOfType(module, "exposed_value");
      return descendants.some((desc) => desc.text === functionName);
    }
    return false;
  }

  public static findExposedTypeOrTypeAliasNode(
    node: SyntaxNode,
    typeName: string,
  ): SyntaxNode | undefined {
    if (node) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        node,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return undefined;
        }
      }
      const descendants = TreeUtils.descendantsOfType(node, "exposed_type");
      const match = descendants.find((desc) => desc.text.startsWith(typeName));
      if (match && match.firstNamedChild) {
        return match.firstNamedChild;
      }
    }
    return undefined;
  }

  public static isExposedTypeOrTypeAlias(
    tree: Tree,
    typeName: string,
  ): boolean {
    const module = this.findModuleDeclaration(tree);
    if (module) {
      const exposingList = this.findFirstNamedChildOfType(
        "exposing_list",
        module,
      );
      if (exposingList) {
        const doubleDot = this.findFirstNamedChildOfType(
          "double_dot",
          exposingList,
        );
        if (doubleDot) {
          return true;
        }
      }
      const descendants = TreeUtils.descendantsOfType(module, "exposed_type");
      return descendants.some((desc) => desc.text.startsWith(typeName));
    }
    return false;
  }

  public static findUnionConstructor(
    tree: Tree,
    unionConstructorName: string,
  ): SyntaxNode | undefined {
    const unionVariants = TreeUtils.descendantsOfType(
      tree.rootNode,
      "union_variant",
    );
    if (unionVariants.length > 0) {
      return unionVariants.find(
        (a) =>
          a.firstChild !== null &&
          a.firstChild.type === "upper_case_identifier" &&
          a.firstChild.text === unionConstructorName,
      );
    }
  }

  public static findUnionConstructorCalls(
    tree: Tree,
    unionConstructorName: string,
  ): SyntaxNode[] | undefined {
    const upperCaseQid = TreeUtils.descendantsOfType(
      tree.rootNode,
      "upper_case_qid",
    );
    if (upperCaseQid.length > 0) {
      const result = upperCaseQid.filter(
        (a) =>
          a.firstChild !== null &&
          a.firstChild.type === "upper_case_identifier" &&
          a.firstChild.text === unionConstructorName &&
          a.parent &&
          a.parent.type !== "type_ref",
      );
      return result.length === 0 ? undefined : result;
    }
  }

  public static findFunction(
    syntaxNode: SyntaxNode,
    functionName: string,
    onlySearchTopLevel = true,
  ): SyntaxNode | undefined {
    const functions = onlySearchTopLevel
      ? syntaxNode.children.filter((a) => a.type === "value_declaration")
      : syntaxNode.descendantsOfType("value_declaration");

    let ret;
    if (functions) {
      ret = functions
        .map((elmFunction) =>
          TreeUtils.findFirstNamedChildOfType(
            "function_declaration_left",
            elmFunction,
          ),
        )
        .find((declaration) => {
          if (declaration && declaration.firstNamedChild) {
            return functionName === declaration.firstNamedChild.text;
          }
        });

      if (!ret) {
        for (const elmFunction of functions) {
          const pattern = TreeUtils.findFirstNamedChildOfType(
            "pattern",
            elmFunction,
          );
          if (pattern) {
            ret =
              pattern
                .descendantsOfType("lower_pattern")
                .find((a) => functionName === a.text) ?? undefined;

            if (ret) {
              break;
            }
          }
        }
      }
      return ret;
    }
  }

  public static findPort(tree: Tree, portName: string): SyntaxNode | undefined {
    return TreeUtils.findAllNamedChildrenOfType(
      "port_annotation",
      tree.rootNode,
    )?.find(
      (node) =>
        node.children.length > 1 &&
        node.children[1].type === "lower_case_identifier" &&
        node.children[1].text === portName,
    );
  }

  public static findOperator(
    tree: Tree,
    operatorName: string,
  ): SyntaxNode | undefined {
    const infixDeclarations = this.findAllNamedChildrenOfType(
      "infix_declaration",
      tree.rootNode,
    );
    if (infixDeclarations) {
      const operatorNode = infixDeclarations.find((a) => {
        const operator = TreeUtils.findFirstNamedChildOfType(
          "operator_identifier",
          a,
        );
        if (operator) {
          return operator.text === operatorName;
        }
        return false;
      });

      if (operatorNode) {
        const functionReference = TreeUtils.findFirstNamedChildOfType(
          "value_expr",
          operatorNode,
        );
        if (functionReference) {
          return this.findFunction(tree.rootNode, functionReference.text);
        }
      }
    }
  }

  public static findTypeDeclaration(
    tree: Tree,
    typeName: string,
  ): SyntaxNode | undefined {
    const types = this.findAllTypeDeclarations(tree);
    if (types) {
      return types.find(
        (a) =>
          a.children.length > 1 &&
          a.children[1].type === "upper_case_identifier" &&
          a.children[1].text === typeName,
      );
    }
  }

  public static findModuleDeclaration(tree: Tree): SyntaxNode | undefined {
    return tree.rootNode.childForFieldName("moduleDeclaration") ?? undefined;
  }

  public static findTypeAliasDeclaration(
    tree: Tree,
    typeAliasName: string,
  ): SyntaxNode | undefined {
    const typeAliases = this.findAllTypeAliasDeclarations(tree);
    if (typeAliases) {
      return typeAliases.find(
        (a) =>
          a.children.length > 2 &&
          a.children[2].type === "upper_case_identifier" &&
          a.children[2].text === typeAliasName,
      );
    }
  }

  public static findAllTopLevelFunctionDeclarations(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    const result = tree.rootNode.children.filter(
      (a) => a.type === "value_declaration",
    );
    return result.length === 0 ? undefined : result;
  }

  public static findAllTopLevelFunctionDeclarationsWithoutTypeAnnotation(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    const result = tree.rootNode.children.filter(
      (a) =>
        a.type === "value_declaration" &&
        a.previousNamedSibling?.type !== "type_annotation",
    );
    return result.length === 0 ? undefined : result;
  }

  public static findAllTypeOrTypeAliasCalls(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    const result: SyntaxNode[] = [];
    const typeRefs = TreeUtils.descendantsOfType(tree.rootNode, "type_ref");
    if (typeRefs.length > 0) {
      typeRefs.forEach((a) => {
        if (
          a.firstChild &&
          a.firstChild.type === "upper_case_qid" &&
          a.firstChild.firstChild
        ) {
          result.push(a.firstChild);
        }
      });
    }

    return result.length === 0 ? undefined : result;
  }

  public static getFunctionNameNodeFromDefinition(
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    if (node.type === "lower_case_identifier") {
      return node;
    }
    const declaration =
      node.type == "function_declaration_left"
        ? node
        : TreeUtils.findFirstNamedChildOfType(
            "function_declaration_left",
            node,
          );
    if (declaration && declaration.firstNamedChild) {
      return declaration.firstNamedChild;
    }
  }

  public static getTypeOrTypeAliasNameNodeFromDefinition(
    node: SyntaxNode,
  ): SyntaxNode | undefined {
    return node.childForFieldName("name") ?? undefined;
  }

  public static findTypeOrTypeAliasCalls(
    tree: Tree,
    typeOrTypeAliasName: string,
  ): SyntaxNode[] | undefined {
    const typeOrTypeAliasNodes = this.findAllTypeOrTypeAliasCalls(tree);
    if (typeOrTypeAliasNodes) {
      const result: SyntaxNode[] = typeOrTypeAliasNodes.filter((a) => {
        return a.text === typeOrTypeAliasName;
      });

      return result.length === 0 ? undefined : result;
    }
  }

  public static findAllTypeDeclarations(tree: Tree): SyntaxNode[] | undefined {
    return this.findAllNamedChildrenOfType("type_declaration", tree.rootNode);
  }

  public static findAllTypeAliasDeclarations(
    tree: Tree,
  ): SyntaxNode[] | undefined {
    return this.findAllNamedChildrenOfType(
      "type_alias_declaration",
      tree.rootNode,
    );
  }

  public static findTypeAliasTypeVariable(
    nodeAtPosition: SyntaxNode,
    nodeAtPositionText: string,
  ): SyntaxNode | undefined {
    const parentTypeAlias = this.findParentOfType(
      "type_alias_declaration",
      nodeAtPosition,
    );

    if (parentTypeAlias) {
      const lowerTypeNames = TreeUtils.findAllNamedChildrenOfType(
        "lower_type_name",
        parentTypeAlias,
      );

      return lowerTypeNames?.find((t) => t.text === nodeAtPositionText);
    }
  }

  public static findImportClauseByName(
    tree: Tree,
    moduleName: string,
  ): SyntaxNode | undefined {
    const allImports = this.findAllImportClauseNodes(tree);
    if (allImports) {
      return allImports.find(
        (a) =>
          a.children.length > 1 &&
          a.children[1].type === "upper_case_qid" &&
          a.children[1].text === moduleName,
      );
    }
  }

  public static findImportNameNode(
    tree: Tree,
    moduleName: string,
  ): SyntaxNode | undefined {
    const allImports = this.findAllImportClauseNodes(tree);
    if (allImports) {
      const match = allImports.find(
        (a) =>
          (a.children.length > 1 &&
            a.children[1].type === "upper_case_qid" &&
            a.children[1].text === moduleName) ||
          (a.children.length > 2 &&
            a.children[2].type === "as_clause" &&
            a.children[2].lastNamedChild?.text === moduleName),
      );
      if (match) {
        return match.children[1];
      }
    }
  }

  public static getTypeOrTypeAliasOfFunctionParameter(
    node: SyntaxNode | undefined,
  ): SyntaxNode | undefined {
    if (
      node &&
      node.parent &&
      node.parent.parent &&
      node.parent.parent.parent &&
      node.parent.parent.parent.previousNamedSibling &&
      node.parent.parent.parent.previousNamedSibling.type ===
        "type_annotation" &&
      node.parent.parent.parent.previousNamedSibling.lastNamedChild
    ) {
      const functionParameterNodes = TreeUtils.findAllNamedChildrenOfType(
        ["pattern", "lower_pattern"],
        node.parent.parent,
      );
      if (functionParameterNodes) {
        const matchIndex = functionParameterNodes.findIndex(
          (a) => a.text === node.text,
        );

        const typeAnnotationNodes = TreeUtils.findAllNamedChildrenOfType(
          ["type_ref", "type_expression"],
          node.parent.parent.parent.previousNamedSibling.lastNamedChild,
        );
        if (typeAnnotationNodes) {
          return typeAnnotationNodes[matchIndex];
        }
      }
    }
  }

  public static getReturnTypeOrTypeAliasOfFunctionDefinition(
    node: SyntaxNode | undefined,
  ): SyntaxNode | undefined {
    if (node && node.previousNamedSibling?.type === "type_annotation") {
      const typeAnnotationNodes = TreeUtils.descendantsOfType(
        node.previousNamedSibling,
        "type_ref",
      );
      if (typeAnnotationNodes) {
        const type = typeAnnotationNodes[typeAnnotationNodes.length - 1];
        return type.firstNamedChild?.firstNamedChild ?? type;
      }
    }
  }

  public static getTypeOrTypeAliasOfFunctionRecordParameter(
    node: SyntaxNode | undefined,
    treeContainer: ITreeContainer,
    elmWorkspace: IElmWorkspace,
  ): SyntaxNode | undefined {
    const checker = elmWorkspace.getTypeChecker();
    if (
      node?.parent?.type === "function_call_expr" &&
      node.parent.firstNamedChild
    ) {
      const parameterIndex =
        node.parent.namedChildren.map((c) => c.text).indexOf(node.text) - 1;

      const functionName = TreeUtils.descendantsOfType(
        node.parent.firstNamedChild,
        "lower_case_identifier",
      );

      const functionDefinition = checker.findDefinition(
        functionName[functionName.length - 1],
        treeContainer,
      );

      if (functionDefinition?.node.previousNamedSibling?.lastNamedChild) {
        const typeAnnotationNodes = TreeUtils.findAllNamedChildrenOfType(
          ["type_ref", "record_type"],
          functionDefinition.node.previousNamedSibling.lastNamedChild,
        );

        if (typeAnnotationNodes) {
          const typeNode = typeAnnotationNodes[parameterIndex];

          if (typeNode?.type === "type_ref") {
            const typeNodes = TreeUtils.descendantsOfType(
              typeNode,
              "upper_case_identifier",
            );

            if (typeNodes.length > 0) {
              return checker.findDefinition(typeNodes[0], treeContainer)?.node;
            }
          } else {
            return typeNode || undefined;
          }
        }
      }
    }
  }

  public static getTypeAliasOfRecordField(
    node: SyntaxNode | undefined,
    treeContainer: ITreeContainer,
    elmWorkspace: IElmWorkspace,
  ): { node: SyntaxNode; uri: string } | undefined {
    const fieldName = node?.parent?.firstNamedChild?.text;

    let recordType = TreeUtils.getTypeAliasOfRecord(
      node,
      treeContainer,
      elmWorkspace,
    );

    while (!recordType && node?.parent?.parent) {
      node = node.parent.parent;
      recordType = TreeUtils.getTypeAliasOfRecordField(
        node,
        treeContainer,
        elmWorkspace,
      );
    }

    const recordTypeTree = elmWorkspace
      .getForest()
      .getByUri(recordType?.uri ?? "");

    if (recordType && recordTypeTree) {
      const fieldTypes = TreeUtils.descendantsOfType(
        recordType.node,
        "field_type",
      );
      const fieldNode = fieldTypes.find((a) => {
        return (
          TreeUtils.findFirstNamedChildOfType("lower_case_identifier", a)
            ?.text === fieldName
        );
      });

      if (fieldNode) {
        const typeExpression = TreeUtils.findFirstNamedChildOfType(
          "type_expression",
          fieldNode,
        );

        if (typeExpression) {
          const typeNode = TreeUtils.descendantsOfType(
            typeExpression,
            "upper_case_identifier",
          );

          if (typeNode.length > 0) {
            const typeAliasNode = elmWorkspace
              .getTypeChecker()
              .findDefinition(typeNode[0], recordTypeTree);

            if (typeAliasNode) {
              return { node: typeAliasNode.node, uri: typeAliasNode.uri };
            }
          }
        }
      }
    }
  }

  public static getTypeAliasOfCase(
    type: SyntaxNode | undefined,
    treeContainer: ITreeContainer,
    elmWorkspace: IElmWorkspace,
  ): { node: SyntaxNode; uri: string } | undefined {
    if (type) {
      const definitionNode = elmWorkspace
        .getTypeChecker()
        .findDefinition(type, treeContainer);

      if (definitionNode) {
        const definitionTree = elmWorkspace
          .getForest()
          .getByUri(definitionNode.uri);

        let aliasNode;
        if (definitionNode.nodeType === "FunctionParameter") {
          aliasNode = TreeUtils.getTypeOrTypeAliasOfFunctionParameter(
            definitionNode.node,
          );
        } else if (definitionNode.nodeType === "Function") {
          aliasNode = TreeUtils.getReturnTypeOrTypeAliasOfFunctionDefinition(
            definitionNode.node,
          );
        } else if (definitionNode.nodeType === "FieldType") {
          aliasNode = TreeUtils.findFirstNamedChildOfType(
            "type_expression",
            definitionNode.node,
          );
        } else if (definitionNode.nodeType === "TypeAlias") {
          return { node: definitionNode.node, uri: definitionNode.uri };
        }

        if (aliasNode && definitionTree) {
          const childNode = TreeUtils.descendantsOfType(
            aliasNode,
            "upper_case_identifier",
          );

          if (childNode.length > 0) {
            const typeNode = elmWorkspace
              .getTypeChecker()
              .findDefinition(childNode[0], definitionTree);

            if (typeNode) {
              return { node: typeNode.node, uri: typeNode.uri };
            }
          }
        }
      }
    }
  }

  public static getTypeAliasOfRecord(
    node: SyntaxNode | undefined,
    treeContainer: ITreeContainer,
    elmWorkspace: IElmWorkspace,
  ): { node: SyntaxNode; uri: string } | undefined {
    if (node?.parent?.parent) {
      let type: SyntaxNode | undefined | null =
        TreeUtils.findFirstNamedChildOfType(
          "record_base_identifier",
          node.parent.parent,
        ) ??
        TreeUtils.findFirstNamedChildOfType(
          "record_base_identifier",
          node.parent,
        );

      // Handle records of function returns
      if (!type && node.parent.parent.parent) {
        type =
          TreeUtils.getReturnTypeOrTypeAliasOfFunctionDefinition(
            node.parent.parent.parent,
          )?.parent ?? undefined;
      }

      if (!type) {
        type = node;
      }

      if (type) {
        const definitionNode = elmWorkspace
          .getTypeChecker()
          .findDefinition(
            type.firstNamedChild ? type.firstNamedChild : type,
            treeContainer,
          );

        if (definitionNode) {
          const definitionTree = elmWorkspace
            .getForest()
            .getByUri(definitionNode.uri);

          let aliasNode;
          if (
            definitionNode.nodeType === "FunctionParameter" &&
            definitionNode.node.firstNamedChild
          ) {
            aliasNode = TreeUtils.getTypeOrTypeAliasOfFunctionParameter(
              definitionNode.node.firstNamedChild,
            );
          } else if (definitionNode.nodeType === "Function") {
            aliasNode = TreeUtils.getReturnTypeOrTypeAliasOfFunctionDefinition(
              definitionNode.node,
            );
          } else if (definitionNode.nodeType === "FieldType") {
            aliasNode = TreeUtils.findFirstNamedChildOfType(
              "type_expression",
              definitionNode.node,
            );
          } else if (definitionNode.nodeType === "TypeAlias") {
            return { node: definitionNode.node, uri: definitionNode.uri };
          }

          if (aliasNode && definitionTree) {
            const childNode = TreeUtils.descendantsOfType(
              aliasNode,
              "upper_case_identifier",
            );

            if (childNode.length > 0) {
              const typeNode = elmWorkspace
                .getTypeChecker()
                .findDefinition(childNode[0], definitionTree);

              if (typeNode) {
                return { node: typeNode.node, uri: typeNode.uri };
              }
            }
          }
        }
      }
    }
  }

  public static getAllFieldsFromTypeAlias(
    node: SyntaxNode | undefined,
  ): { field: string; type: string }[] | undefined {
    const result: { field: string; type: string }[] = [];
    if (node) {
      const fieldTypes = TreeUtils.descendantsOfType(node, "field_type");
      if (fieldTypes.length > 0) {
        fieldTypes.forEach((a) => {
          const fieldName = TreeUtils.findFirstNamedChildOfType(
            "lower_case_identifier",
            a,
          );
          const typeExpression = TreeUtils.findFirstNamedChildOfType(
            "type_expression",
            a,
          );
          if (fieldName && typeExpression) {
            result.push({ field: fieldName.text, type: typeExpression.text });
          }
        });
      }
    }
    return result.length === 0 ? undefined : result;
  }

  public static descendantsOfType(
    node: SyntaxNode,
    type: string,
  ): SyntaxNode[] {
    return node.descendantsOfType(type);
  }

  public static getNamedDescendantForPosition(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode {
    const previousCharColumn =
      position.character === 0 ? 0 : position.character - 1;
    const charBeforeCursor = node.text
      .split("\n")
      [position.line].substring(previousCharColumn, position.character);

    if (!functionNameRegex.test(charBeforeCursor)) {
      return node.namedDescendantForPosition({
        column: position.character,
        row: position.line,
      });
    } else {
      return node.namedDescendantForPosition(
        {
          column: previousCharColumn,
          row: position.line,
        },
        {
          column: position.character,
          row: position.line,
        },
      );
    }
  }

  public static findPreviousNode(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode | undefined {
    function nodeHasTokens(n: SyntaxNode): boolean {
      return n.endIndex - n.startIndex !== 0;
    }

    function findRightmostChildWithTokens(
      childrenList: SyntaxNode[],
      startIndex: number,
    ): SyntaxNode | undefined {
      for (let i = startIndex - 1; i >= 0; i--) {
        if (nodeHasTokens(childrenList[i])) {
          return childrenList[i];
        }
      }
    }

    function findRightmostNode(n: SyntaxNode): SyntaxNode | undefined {
      if (n.children.length === 0) {
        return n;
      }

      const candidate = findRightmostChildWithTokens(
        n.children,
        n.children.length,
      );

      if (candidate) {
        return findRightmostNode(candidate);
      }
    }

    const children = node.children;

    if (children.length === 0) {
      return node;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (comparePosition(position, child.endPosition) < 0) {
        const lookInPreviousChild =
          comparePosition(position, child.startPosition) <= 0 ||
          !nodeHasTokens(child);

        if (lookInPreviousChild) {
          const candidate = findRightmostChildWithTokens(children, i);
          if (candidate) {
            return findRightmostNode(candidate);
          }
        } else {
          return this.findPreviousNode(child, position);
        }
      }
    }

    const candidate = findRightmostChildWithTokens(children, children.length);
    if (candidate) {
      return findRightmostNode(candidate);
    }
  }

  public static getNamedDescendantForLineBeforePosition(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode {
    const previousLine = position.line === 0 ? 0 : position.line - 1;

    return node.namedDescendantForPosition({
      column: 0,
      row: previousLine,
    });
  }

  public static getNamedDescendantForLineAfterPosition(
    node: SyntaxNode,
    position: Position,
  ): SyntaxNode {
    const followingLine = position.line + 1;

    return node.namedDescendantForPosition({
      column: 0,
      row: followingLine,
    });
  }

  public static findParentOfType(
    typeToLookFor: string,
    node: SyntaxNode,
    topLevel = false,
  ): SyntaxNode | undefined {
    if (
      node.type === typeToLookFor &&
      (!topLevel || node.parent?.type === "file")
    ) {
      return node;
    }
    if (node.parent) {
      return this.findParentOfType(typeToLookFor, node.parent, topLevel);
    }
  }

  public static getLastImportNode(tree: Tree): SyntaxNode | undefined {
    const allImportNodes = this.findAllImportClauseNodes(tree);
    if (allImportNodes?.length) {
      return allImportNodes[allImportNodes.length - 1];
    }
  }

  public static isReferenceFullyQualified(node: SyntaxNode): boolean {
    return (
      node.previousNamedSibling?.type === "dot" &&
      node.previousNamedSibling?.previousNamedSibling?.type ===
        "upper_case_identifier"
    );
  }

  public static getTypeAnnotation(
    valueDeclaration?: SyntaxNode,
  ): SyntaxNode | undefined {
    if (valueDeclaration?.type !== "value_declaration") {
      return;
    }

    let candidate = valueDeclaration.previousNamedSibling;

    // Skip comments
    while (
      candidate?.type === "line_comment" ||
      candidate?.type === "comment_block"
    ) {
      candidate = candidate.previousNamedSibling;
    }

    if (candidate?.type === "type_annotation") {
      return candidate;
    }
  }

  /**
   * This gets a list of all ancestors of a type
   * in order from the closest declaration up to the top level declaration
   */
  public static getAllAncestorsOfType(
    type: string,
    node: SyntaxNode,
  ): SyntaxNode[] {
    const declarations = [];

    while (node.type !== "file") {
      if (node.type === type) {
        declarations.push(node);
      }

      if (node.parent) {
        node = node.parent;
      } else {
        break;
      }
    }

    return declarations;
  }

  public static findAllImportClauseNodes(tree: Tree): SyntaxNode[] | undefined {
    const result = tree.rootNode.children.filter(
      (a) => a.type === "import_clause",
    );

    return result.length === 0 ? undefined : result;
  }

  public static isIdentifier(node: SyntaxNode): boolean {
    return (
      node.type === "lower_case_identifier" ||
      node.type === "upper_case_identifier"
    );
  }

  public static isImport(node: SyntaxNode): boolean {
    return (
      node.parent?.firstNamedChild?.type === "import" ||
      node.parent?.parent?.firstNamedChild?.type === "import"
    );
  }

  public static nextNode(node: SyntaxNode): SyntaxNode | undefined {
    // Move up until we have a sibling
    while (!node.nextNamedSibling && node.parent) {
      node = node.parent;
    }

    if (node.nextNamedSibling) {
      node = node.nextNamedSibling;

      // Move down the leftmost subtree
      while (node.firstNamedChild) {
        node = node.firstNamedChild;
      }

      return node;
    }
  }

  public static findFieldReference(
    type: Type,
    fieldName: string,
  ): { node: SyntaxNode; uri: string; nodeType: NodeType } | undefined {
    if (type.nodeType === "Record") {
      const fieldRefs = type.fieldReferences.get(fieldName);

      if (fieldRefs.length > 0) {
        const refUri = fieldRefs[0]?.tree.uri;

        if (refUri) {
          return {
            node: fieldRefs[0],
            nodeType: "FieldType",
            uri: refUri,
          };
        }
      }
    }
  }
}
