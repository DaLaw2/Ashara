/** Graph traversal + keyword search contract, implemented in-process by InProcessGraphClient */

export interface GraphTraversalResult {
    readonly symbolName: string;
    readonly symbolKind: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly signature?: string;
    readonly distance: number;
}

export interface KeywordResult {
    readonly symbolName: string;
    readonly symbolKind: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly score: number;
}

export interface GraphClient {
    traverseFromSymbols(symbolNames: string[], hops: number): Promise<GraphTraversalResult[]>;
    keywordSearch(query: string, topK: number): Promise<KeywordResult[]>;
}
