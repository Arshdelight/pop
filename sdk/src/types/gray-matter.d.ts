declare module 'gray-matter' {
  interface GrayMatterOptions {
    engine?: unknown;
    excerpt?: boolean;
    language?: string;
  }

  interface GrayMatterFile {
    data: Record<string, unknown>;
    content: string;
    excerpt?: string;
    isEmpty: boolean;
    matter: string;
  }

  function matter(input: string, options?: GrayMatterOptions): GrayMatterFile;

  namespace matter {
    function stringify(content: string, data: Record<string, unknown>): string;
    function test(input: string): boolean;
  }

  export = matter;
}
