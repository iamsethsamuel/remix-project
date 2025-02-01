import { PluginClient } from '@remixproject/plugin'
import { createClient } from '@remixproject/plugin-webview'
import EventManager from 'events'
// @ts-ignore
import { compile_program, createFileManager } from '@noir-lang/noir_wasm/default'
import type { FileManager } from '@noir-lang/noir_wasm/dist/node/main'
import pathModule from 'path'
import { DEFAULT_TOML_CONFIG } from '../actions/constants'
import NoirParser from './noirParser'
export class NoirPluginClient extends PluginClient {
  public internalEvents: EventManager
  public fm: FileManager
  public parser: NoirParser

  constructor() {
    super()
    this.methods = ['init', 'parse', 'compile']
    createClient(this)
    this.internalEvents = new EventManager()
    this.fm = createFileManager('/')
    this.parser = new NoirParser()
    this.onload()
  }

  init(): void {
    console.log('initializing noir plugin...')
  }

  onActivation(): void {
    this.internalEvents.emit('noir_activated')
    this.setup()
  }

  async setup(): Promise<void> {
    // @ts-ignore
    const nargoTomlExists = await this.call('fileManager', 'exists', 'Nargo.toml')

    if (!nargoTomlExists) {
      await this.call('fileManager', 'writeFile', 'Nargo.toml', DEFAULT_TOML_CONFIG)
      const fileBytes = new TextEncoder().encode(DEFAULT_TOML_CONFIG)

      this.fm.writeFile('Nargo.toml', new Blob([fileBytes]).stream())
    } else {
      const nargoToml = await this.call('fileManager', 'readFile', 'Nargo.toml')
      const fileBytes = new TextEncoder().encode(nargoToml)

      this.fm.writeFile('Nargo.toml', new Blob([fileBytes]).stream())
    }
  }

  async compile(path: string): Promise<void> {
    try {
      this.internalEvents.emit('noir_compiling_start')
      this.emit('statusChanged', { key: 'loading', title: 'Compiling Noir Circuit...', type: 'info' })
      // @ts-ignore
      this.call('terminal', 'log', { type: 'log', value: 'Compiling ' + path })
      const program = await compile_program(this.fm)

      console.log('program: ', program)
      this.internalEvents.emit('noir_compiling_done')
      this.emit('statusChanged', { key: 'succeed', title: 'Noir circuit compiled successfully', type: 'success' })
    } catch (e) {
      this.emit('statusChanged', { key: 'error', title: e.message, type: 'error' })
      this.internalEvents.emit('noir_compiling_errored', e)
      console.error(e)
    }
  }

  async parse(path: string, content?: string): Promise<void> {
    if (!content) content = await this.call('fileManager', 'readFile', path)
    await this.resolveDependencies(path, content)
    const result = this.parser.parseNoirCode(content)

    console.log('result: ', result)
    const fileBytes = new TextEncoder().encode(content)

    this.fm.writeFile(`${path}`, new Blob([fileBytes]).stream())
  }

  async resolveDependencies (filePath: string, fileContent: string, parentPath: string = '', visited: Record<string, string[]> = {}): Promise<void> {
    const imports = Array.from(fileContent.matchAll(/mod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(=\s*["'](.*?)["'])?\s*;/g), match => match[3] || match[1]);

    for (let dep of imports) {
      if (!dep.endsWith('.nr')) dep += '.nr'
      if (visited[filePath] && visited[filePath].includes(parentPath)) return console.log('circular dependency detected')
      let dependencyContent = ''
      let path = dep.replace(/(\.\.\/)+/g, '')

      // @ts-ignore
      const pathExists = await this.call('fileManager', 'exists', path)

      if (pathExists) {
        dependencyContent = await this.call('fileManager', 'readFile', path)
      } else {
        let relativePath = pathModule.resolve(filePath.slice(0, filePath.lastIndexOf('/')), dep)

        if (relativePath.indexOf('/') === 0) relativePath = relativePath.slice(1)
        // @ts-ignore
        const relativePathExists = await this.call('fileManager', 'exists', relativePath)

        if (relativePathExists) {
          path = relativePath
          dependencyContent = await this.call('fileManager', 'readFile', relativePath)
          visited[filePath] = visited[filePath] ? [...visited[filePath], path] : [path]
          // extract all mod imports from the dependency content
          const depImports = Array.from(fileContent.matchAll(/mod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(=\s*["'](.*?)["'])?\s*;/g), match => match[3] || match[1])

          if (depImports.length > 0 && dependencyContent.length > 0) {
            const fileBytes = new TextEncoder().encode(dependencyContent)
            const writePath = parentPath ? `${filePath.replace('.nr', '')}/${dep}` : path

            this.fm.writeFile(writePath, new Blob([fileBytes]).stream())
            await this.resolveDependencies(path, dependencyContent, filePath, visited)
          }
        } else {
          throw new Error(`Dependency ${dep} not found in Remix file system`)
        }
      }
    }
  }
}
