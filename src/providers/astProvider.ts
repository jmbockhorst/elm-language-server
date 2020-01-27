import { readFileSync } from "fs";

import {
  DidChangeTextDocumentParams,
  IConnection,
  VersionedTextDocumentIdentifier,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import Parser, { Point, SyntaxNode, Tree } from "web-tree-sitter";
import { ElmWorkspace } from "../elmWorkspace";
import { Position } from "../position";
import { IDocumentEvents } from "../util/documentEvents";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";

export class ASTProvider {
  constructor(
    private connection: IConnection,
    elmWorkspaces: ElmWorkspace[],
    documentEvents: IDocumentEvents,
    private parser: Parser,
  ) {
    documentEvents.on(
      "change",
      new ElmWorkspaceMatcher(
        elmWorkspaces,
        (params: DidChangeTextDocumentParams) =>
          URI.parse(params.textDocument.uri),
      ).handlerForWorkspace(this.handleChangeTextDocument),
    );
  }

  protected handleChangeTextDocument = async (
    params: DidChangeTextDocumentParams,
    elmWorkspace: ElmWorkspace,
  ): Promise<void> => {
    this.connection.console.info(
      `Changed text document, going to parse it. ${params.textDocument.uri}`,
    );
    const forest = elmWorkspace.getForest();
    const imports = elmWorkspace.getImports();
    const document: VersionedTextDocumentIdentifier = params.textDocument;

    let tree: Tree | undefined = forest.getTree(document.uri);
    if (tree === undefined) {
      const fileContent: string = readFileSync(
        URI.parse(document.uri).fsPath,
        "utf8",
      );
      tree = this.parser.parse(fileContent);
    }

    for (const changeEvent of params.contentChanges) {
      // TODO why doesn't this work anymore?
      // if (changeEvent.range && changeEvent.rangeLength) {
      //   // range is range of the change. end is exclusive
      //   // rangeLength is length of text removed
      //   // text is new text
      //   const { range, rangeLength, text } = changeEvent;
      //   const startIndex: number = range.start.line * range.start.character;
      //   const oldEndIndex: number = startIndex + rangeLength - 1;
      //   if (tree) {
      //     tree.edit({
      //       // end index for new version of text
      //       newEndIndex: range.end.line * range.end.character - 1,
      //       // position in new doc change ended
      //       newEndPosition: Position.FROM_VS_POSITION(range.end).toTSPosition(),

      //       // end index for old version of text
      //       oldEndIndex,
      //       // position in old doc change ended.
      //       oldEndPosition: this.computeEndPosition(
      //         startIndex,
      //         oldEndIndex,
      //         tree,
      //       ),

      //       // index in old doc the change started
      //       startIndex,
      //       // position in old doc change started
      //       startPosition: Position.FROM_VS_POSITION(
      //         range.start,
      //       ).toTSPosition(),
      //     });
      //     tree = this.parser.parse(text, tree);
      //   }
      // } else {
      tree = this.parser.parse(changeEvent.text);
      // }
    }
    if (tree) {
      forest.setTree(document.uri, true, true, tree);
      imports.updateImports(document.uri, tree, forest);
    }
  };

  private computeEndPosition = (
    startIndex: number,
    endIndex: number,
    tree: Tree,
  ): Point => {
    const node: SyntaxNode = tree.rootNode.descendantForIndex(
      startIndex,
      endIndex,
    );

    return node.endPosition;
  };
}
