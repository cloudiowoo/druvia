'use client';

import { useState, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { graphql } from 'cm6-graphql';
import { json } from '@codemirror/lang-json';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import { api } from '@/lib/api';
import { getPublicApiBaseUrl } from '@/lib/public-env';
import { Button } from '@/components/ui/button';
import { Play, Loader2 } from 'lucide-react';

interface GraphQLEditorProps {
  projectId: string;
}

export function GraphQLEditor({ projectId }: GraphQLEditorProps) {
  const [query, setQuery] = useState(`query {

}`);
  const [variables, setVariables] = useState('{}');
  const [result, setResult] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBaseUrl = getPublicApiBaseUrl();
  const fetcher = useMemo(() => createGraphiQLFetcher({
    url: `${apiBaseUrl}/api/v1/projects/${projectId}/graphql`,
    headers: {
      'Authorization': `Bearer ${api.getToken()}`,
    },
  }), [apiBaseUrl, projectId]);

  const executeQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let vars = {};
      try {
        vars = JSON.parse(variables);
      } catch {
        // 忽略变量解析错误
      }

      const response = await fetcher({
        query,
        variables: vars,
      });

      // Handle async iterator (subscriptions) or direct result
      if (Symbol.asyncIterator in response) {
        const iterator = response[Symbol.asyncIterator]();
        const { value } = await iterator.next();
        setResult(JSON.stringify(value, null, 2));
      } else {
        setResult(JSON.stringify(response, null, 2));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed');
      setResult('');
    } finally {
      setLoading(false);
    }
  }, [query, variables, fetcher]);

  // 快捷键
  const customKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              executeQuery();
              return true;
            },
            preventDefault: true,
          },
        ])
      ),
    [executeQuery]
  );

  const queryExtensions = useMemo(() => [
    graphql(),
    customKeymap,
  ], [customKeymap]);

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <span className="text-sm font-medium">GraphQL Playground</span>
        <Button
          size="sm"
          onClick={executeQuery}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Play className="h-4 w-4 mr-1" />
          )}
          执行
        </Button>
      </div>

      {/* 编辑器区域 */}
      <div className="flex-1 flex">
        {/* 左侧：查询和变量 */}
        <div className="w-1/2 flex flex-col border-r">
          {/* 查询编辑器 */}
          <div className="flex-1 overflow-hidden">
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20">
              Query
            </div>
            <CodeMirror
              value={query}
              onChange={setQuery}
              extensions={queryExtensions}
              height="100%"
              className="h-full"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
              }}
              theme="light"
            />
          </div>

          {/* 变量编辑器 */}
          <div className="h-32 border-t">
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20">
              Variables (JSON)
            </div>
            <CodeMirror
              value={variables}
              onChange={setVariables}
              extensions={[json()]}
              height="calc(100% - 28px)"
              basicSetup={{
                lineNumbers: true,
                bracketMatching: true,
                closeBrackets: true,
              }}
              theme="light"
            />
          </div>
        </div>

        {/* 右侧：结果 */}
        <div className="w-1/2 flex flex-col">
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20">
            Response
          </div>
          {error ? (
            <div className="flex-1 p-4 text-red-500 text-sm">
              {error}
            </div>
          ) : (
            <CodeMirror
              value={result}
              extensions={[json()]}
              height="100%"
              className="h-full"
              readOnly
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
              }}
              theme="light"
            />
          )}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-t bg-muted/20 flex justify-end">
        <span>
          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">⌘</kbd>
          <span className="mx-0.5">+</span>
          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Enter</kbd>
          <span className="ml-1">执行查询</span>
        </span>
      </div>
    </div>
  );
}
