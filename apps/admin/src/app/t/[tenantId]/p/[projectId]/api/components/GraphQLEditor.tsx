'use client';

import { useState, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { graphql } from 'cm6-graphql';
import { json } from '@codemirror/lang-json';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import { getPublicApiBaseUrl } from '@/lib/public-env';
import {
  buildGraphqlCredentialHeaders,
  buildProjectGraphqlEndpoint,
  type GraphqlCredentialMode,
} from '@/lib/project-graphql';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eye, EyeOff, KeyRound, Loader2, Play, UserRound } from 'lucide-react';

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
  const [credentialMode, setCredentialMode] = useState<GraphqlCredentialMode>('apikey');
  const [credential, setCredential] = useState('');
  const [showCredential, setShowCredential] = useState(false);

  const apiBaseUrl = getPublicApiBaseUrl();
  const credentialHeaders = useMemo(
    () => buildGraphqlCredentialHeaders(credentialMode, credential),
    [credentialMode, credential]
  );
  const fetcher = useMemo(() => {
    if (!credentialHeaders) return null;

    return createGraphiQLFetcher({
      url: buildProjectGraphqlEndpoint(apiBaseUrl, projectId),
      headers: credentialHeaders,
    });
  }, [apiBaseUrl, credentialHeaders, projectId]);

  const executeQuery = useCallback(async () => {
    if (!fetcher) return;

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

  const changeCredentialMode = (mode: GraphqlCredentialMode) => {
    setCredentialMode(mode);
    setCredential('');
    setShowCredential(false);
    setError(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-4 py-3">
        <span className="mr-auto text-sm font-medium">GraphQL Playground</span>

        <div className="flex h-9 shrink-0 items-center rounded-md border bg-background p-0.5">
          <button
            type="button"
            onClick={() => changeCredentialMode('apikey')}
            className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
              credentialMode === 'apikey'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            aria-pressed={credentialMode === 'apikey'}
          >
            <KeyRound className="h-3.5 w-3.5" />
            API Key
          </button>
          <button
            type="button"
            onClick={() => changeCredentialMode('project_user')}
            className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
              credentialMode === 'project_user'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            aria-pressed={credentialMode === 'project_user'}
          >
            <UserRound className="h-3.5 w-3.5" />
            项目令牌
          </button>
        </div>

        <div className="relative min-w-[240px] flex-1 sm:max-w-sm">
          <Input
            type={showCredential ? 'text' : 'password'}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder={credentialMode === 'apikey' ? '输入项目 API Key' : '输入 Project access token'}
            className="h-9 pr-10 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            aria-label={credentialMode === 'apikey' ? '项目 API Key' : 'Project access token'}
          />
          <button
            type="button"
            onClick={() => setShowCredential((visible) => !visible)}
            className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            title={showCredential ? '隐藏凭证' : '显示凭证'}
            aria-label={showCredential ? '隐藏凭证' : '显示凭证'}
          >
            {showCredential ? <EyeOff /> : <Eye />}
          </button>
        </div>

        <Button size="sm" onClick={executeQuery} disabled={loading || !credentialHeaders}>
          {loading ? <Loader2 className="animate-spin" /> : <Play />}
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

    </div>
  );
}
