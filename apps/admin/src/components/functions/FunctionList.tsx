'use client';

import { useState } from 'react';
import { Plus, Code, MoreVertical, Trash2, Power, PowerOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EdgeFunction } from '@/lib/api';

interface FunctionListProps {
  functions: EdgeFunction[];
  selectedFunction: EdgeFunction | null;
  onSelect: (func: EdgeFunction) => void;
  onCreate: () => void;
  onDelete: (func: EdgeFunction) => void;
  onToggleStatus: (func: EdgeFunction) => void;
  confirmDeleteId?: string | null;
}

export function FunctionList({
  functions,
  selectedFunction,
  onSelect,
  onCreate,
  onDelete,
  onToggleStatus,
  confirmDeleteId,
}: FunctionListProps) {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-gray-700">Functions</h2>
            <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-md">
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              项目级别
            </span>
          </div>
        </div>
        <button
          onClick={onCreate}
          className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          title="新建函数"
        >
          <Plus className="h-5 w-5 text-gray-600" />
        </button>
      </div>

      {/* Function List */}
      <div className="flex-1 overflow-y-auto">
        {functions.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            暂无函数
            <button
              onClick={onCreate}
              className="block mx-auto mt-2 text-blue-600 hover:underline"
            >
              创建第一个函数
            </button>
          </div>
        ) : (
          <ul>
            {functions.map((func) => (
              <li
                key={func.id}
                className={cn(
                  "relative group flex items-center gap-3 px-4 py-3 cursor-pointer border-b",
                  "hover:bg-gray-50 transition-colors",
                  selectedFunction?.id === func.id && "bg-blue-50 border-l-2 border-l-blue-500"
                )}
                onClick={() => onSelect(func)}
              >
                {/* Icon */}
                <div className={cn(
                  "p-2 rounded-lg",
                  func.status === 'active' ? "bg-green-100" : "bg-gray-100"
                )}>
                  <Code className={cn(
                    "h-4 w-4",
                    func.status === 'active' ? "text-green-600" : "text-gray-400"
                  )} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{func.name}</p>
                  <p className="text-xs text-gray-500">
                    {func.status === 'active' ? '运行中' : '已禁用'}
                  </p>
                </div>

                {/* Menu */}
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(menuOpen === func.id ? null : func.id);
                    }}
                    className="p-1 hover:bg-gray-200 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <MoreVertical className="h-4 w-4 text-gray-500" />
                  </button>

                  {menuOpen === func.id && (
                    <div className="absolute right-0 top-full mt-1 w-36 bg-white border rounded-lg shadow-lg z-10">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleStatus(func);
                          setMenuOpen(null);
                        }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
                      >
                        {func.status === 'active' ? (
                          <>
                            <PowerOff className="h-4 w-4" />
                            禁用
                          </>
                        ) : (
                          <>
                            <Power className="h-4 w-4" />
                            启用
                          </>
                        )}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(func);
                          if (confirmDeleteId === func.id) {
                            setMenuOpen(null);
                          }
                        }}
                        className={cn(
                          "w-full px-3 py-2 text-left text-sm flex items-center gap-2",
                          confirmDeleteId === func.id
                            ? "bg-red-500 text-white hover:bg-red-600"
                            : "hover:bg-gray-50 text-red-600"
                        )}
                      >
                        <Trash2 className="h-4 w-4" />
                        {confirmDeleteId === func.id ? '确认删除' : '删除'}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
