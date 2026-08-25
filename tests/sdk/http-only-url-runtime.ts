export function createHttpOnlyUrlConstructor(NativeURL: typeof URL): typeof URL {
  class HttpOnlyURL {
    readonly protocol: string
    readonly host: string
    readonly pathname: string
    readonly search: string
    readonly hash: string

    constructor(input: string | URL, base?: string | URL) {
      const value = String(input)
      if (!/^https?:\/\//i.test(value)) {
        throw new TypeError('This runtime URL implementation only supports HTTP(S)')
      }

      const parsed = new NativeURL(value, base)
      this.protocol = parsed.protocol
      this.host = parsed.host
      this.pathname = parsed.pathname
      this.search = parsed.search
      this.hash = parsed.hash
    }

    toString(): string {
      return `${this.protocol}//${this.host}${this.pathname}${this.search}${this.hash}`
    }
  }

  return HttpOnlyURL as unknown as typeof URL
}
