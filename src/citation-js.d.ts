declare module '@citation-js/core' {
  export class Cite {
    constructor(data: unknown);
    data: Record<string, any>[];
    format(format: string, options?: Record<string, unknown>): string;
  }
}
declare module '@citation-js/plugin-bibtex';
declare module '@citation-js/plugin-ris';
