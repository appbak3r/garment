import {
  defineOptionsFromJSONSchema,
  defineRunner,
  File
} from '@garment/runner';
import * as Path from 'path';
import * as ts from 'typescript';

/**
 * Runs TypeScript compiler
 * @example {
    "runner": "ts",
    "input": "{{projectDir}}/src/**\/*.ts",
    "output": "{{projectDir}}/lib",
    "options": {
      "configFile": "tsconfig.lib.json"
    }
  }
 */
export interface TSRunnerOptions {
  /**
   * Path to tsconfig.json file
   * @format path
   * @default tsconfig.json
   */
  configFile: string;

  /**
   * @format path
   */
  // sourceRoot?: string;
}

export const tsRunnerOptions = defineOptionsFromJSONSchema<TSRunnerOptions>(
  require('./schema.json')
);

const sourceFilesCache: {
  [fileName: string]: ts.SourceFile | undefined;
} = {};

export default defineRunner(tsRunnerOptions, async ctx => {
  const { configFile } = ctx.options;

  const filesCache: {
    [fileName: string]:
      | { isExternal?: boolean; lastModified?: number; content?: string }
      | undefined;
  } = {};

  function getCompilerOptionsRecursively(currentConfigPath: string): any {
    const { extends: extendsOption, compilerOptions } = JSON.parse(
      ctx.fs.readFileSync(currentConfigPath, 'utf8')
    );

    ctx.dependsOnFile(currentConfigPath);

    if (extendsOption) {
      const currentDir = Path.dirname(currentConfigPath);
      const parentConfigPath = Path.resolve(currentDir, extendsOption);
      const parentCompilerOptions = getCompilerOptionsRecursively(
        ctx.fs.existsSync(parentConfigPath)
          ? parentConfigPath
          : require.resolve(currentConfigPath)
      );
      return {
        ...parentCompilerOptions,
        ...compilerOptions
      };
    } else {
      return compilerOptions;
    }
  }

  const compilerOptions = getCompilerOptionsRecursively(configFile);

  const cacheKeys = [
    require('typescript/package.json').version,
    JSON.stringify(compilerOptions)
  ];

  const config = ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        ...compilerOptions
      }
    },
    ts.sys,
    ''
  );

  const hostBase = ts.createCompilerHost(config.options);
  const host: typeof hostBase = {
    ...hostBase,
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: fileName => {
      if (filesCache[fileName]) {
        return true;
      }
      return ts.sys.fileExists(fileName);
    },
    getSourceFile(fileName) {
      if (fileName.endsWith('.d.ts')) {
        const stats = ctx.fs.statSync(fileName);
        let file = filesCache[fileName];
        if (!file) {
          file = {
            isExternal: true,
            lastModified: stats.mtimeMs
          };
          filesCache[fileName] = file;
        }
        if (stats.mtimeMs > (file.lastModified ?? 0)) {
          sourceFilesCache[fileName] = undefined;
        }
      }
      if (!sourceFilesCache[fileName]) {
        sourceFilesCache[fileName] = ts.createSourceFile(
          fileName,
          host.readFile(fileName) ?? '',
          config.options.target ?? ts.ScriptTarget.ES2015,
          true
        );
      }
      return sourceFilesCache[fileName];
    },
    readFile: fileName => {
      const file = filesCache[fileName];
      if (!file?.isExternal && file?.content) {
        return file.content;
      }
      return ctx.fs.readFileSync(fileName, 'utf8');
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: fileName =>
      Object.keys(filesCache).some(
        _ => Path.dirname(_).indexOf(fileName) === 0
      ) || ts.sys.directoryExists(fileName),

    getDirectories: ts.sys.getDirectories
  };

  // let program: ts.Program;

  ctx.input(async files => {
    for (const file of files) {
      registerInputFile(file);
    }

    const program = ts.createProgram(
      Object.keys(filesCache),
      config.options,
      host
    );

    return getOutputsForFiles(program, ...files);
  });

  async function getOutputsForFiles(
    program: ts.Program,
    ...filesToProcess: File[]
  ) {
    const outputs = [];

    for (const file of filesToProcess) {
      const { absolutePath, baseDir, path, data } = file;
      const fileName = absolutePath ?? path;

      const sourceFile = host.getSourceFile(
        fileName,
        config.options.target ?? ts.ScriptTarget.ES2015
      );
      if (!sourceFile) {
        throw new Error(`Couldn't find a source file for "${fileName}"`);
      }

      const { directDepsRealPaths, allDepsContent } = traverseDeps(sourceFile);

      const outputContainer = ctx.createOutputContainer(
        file,
        [...cacheKeys, ...allDepsContent],
        directDepsRealPaths
      );

      if (await outputContainer.isNotCached) {
        if (!program) {
          program = ts.createProgram(
            Object.keys(filesCache),
            config.options,
            host
          );
        }

        if (path.endsWith('.d.ts')) {
          ctx.logger.debug('[TS] Typing found, left unprocessed', path);

          if (config.options.declaration) {
            outputContainer.add(file);
          }
        } else {
          ctx.logger.debug('[TS] Processing', path);

          const { files, warnings, errors } = await emit(program, sourceFile);

          for (const outputFile of files) {
            const relFilename = Path.relative(
              baseDir ?? ctx.workspace.cwd,
              outputFile.fileName
            );
            outputContainer.add(ctx.file.text(relFilename, outputFile.data));
          }

          for (const warning of warnings) {
            outputContainer.logger.warn(warning);
          }

          for (const error of errors) {
            outputContainer.logger.error(error);
          }
        }
      } else {
        ctx.logger.debug('[TS] Found in cache', path);
      }

      outputs.push(outputContainer);
    }

    return outputs;
  }

  async function emit(program: ts.Program, sourceFile: ts.SourceFile) {
    const files: { fileName: string; data: string }[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    const emitResult = await new Promise<ReturnType<typeof program.emit>>(
      resolve =>
        resolve(
          program.emit(sourceFile, (fileName, data) => {
            files.push({ fileName, data });
          })
        )
    );

    if (emitResult.emitSkipped) {
      for (const diagnostic of emitResult.diagnostics) {
        let message = '';
        if (diagnostic.file && diagnostic.start) {
          const {
            line,
            character
          } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
          message += `${diagnostic.file.fileName}:${line + 1}:${character +
            1}\n`;
        }
        message += [...getAllMessages(diagnostic.messageText)].join('\n');
        if (diagnostic.category === ts.DiagnosticCategory.Warning) {
          warnings.push(message);
        } else if (diagnostic.category === ts.DiagnosticCategory.Error) {
          errors.push(message);
        }
      }
    }

    return { files, warnings, errors };
  }

  function registerInputFile(file: File) {
    const { absolutePath, data, path } = file;
    const content = data.toString('utf8');

    const fileName = absolutePath ?? path;

    sourceFilesCache[fileName] = undefined;

    let cachedFile = filesCache[fileName];
    if (cachedFile) {
      filesCache[fileName] = {
        ...cachedFile,
        content
      };
    } else {
      filesCache[fileName] = {
        content
      };
    }
    return filesCache[fileName];
  }

  function traverseDeps(sourceFile: ts.SourceFile) {
    const directDepsRealPaths: string[] = [];

    const checkedPaths = new Set<string>();
    const allDepsContent: string[] = [];

    function walk(sourceFile: ts.SourceFile, level = 0) {
      const { fileName, text } = sourceFile;
      if (!checkedPaths.has(fileName)) {
        checkedPaths.add(fileName);
      } else {
        return;
      }

      allDepsContent.push(text);

      const moduleSpecifiers: string[] = [];

      ts.forEachChild(sourceFile, node => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          moduleSpecifiers.push((node.moduleSpecifier as any).text);
        }
      });

      const resolvedModuleFileNames = moduleSpecifiers
        .map(
          name =>
            ts.resolveModuleName(
              name,
              sourceFile.fileName,
              config.options,
              host
            ).resolvedModule?.resolvedFileName!
        )
        .filter(Boolean);

      for (const resolvedModuleFileName of resolvedModuleFileNames) {
        if (level === 0) {
          directDepsRealPaths.push(resolvedModuleFileName);
        }
        const project = ctx.workspace.projects.getByPath(
          resolvedModuleFileName
        );
        if (project) {
          const sourceFile = host.getSourceFile(
            resolvedModuleFileName,
            config.options.target ?? ts.ScriptTarget.ES2015
          );
          if (sourceFile) {
            walk(sourceFile, level + 1);
          }
        }
      }
    }

    walk(sourceFile);

    return {
      directDepsRealPaths,
      allDepsContent
    };
  }
});

function* getAllMessages(messageText: string | ts.DiagnosticMessageChain) {
  if (typeof messageText === 'string') {
    yield messageText;
  } else {
    let currentMessageText: ts.DiagnosticMessageChain = messageText;

    do {
      yield currentMessageText.messageText;
      if (currentMessageText.next) {
        currentMessageText = currentMessageText.next as any; // TODO fix when rework TS runner;
      }
    } while (currentMessageText.next);
  }
}