// src/webview/nodes/PageNode.tsx
// Custom ReactFlow node for frontend pages/screens (React Web routes, RN screens)

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export interface PageNodeData {
  name: string;
  path?: string;
  component?: string;
  navType?: 'tab' | 'stack' | 'route';
  auth?: boolean;
}

const NAV_ICONS: Record<string, string> = {
  tab: '📑',
  stack: '📱',
  route: '🌐',
};

function PageNode({ data }: NodeProps<PageNodeData>) {
  const icon = NAV_ICONS[data.navType || 'route'] || '📄';
  const isAuth = data.auth;

  return (
    <div className={`tf-node tf-page-node ${isAuth ? 'auth' : ''}`}>
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: '#58a6ff', border: 'none', width: 6, height: 6 }}
      />

      <div className="tf-page-header">
        <span className="tf-page-icon">{icon}</span>
        <div className="tf-page-info">
          <span className="tf-page-name">{data.name}</span>
          {data.path && (
            <span className="tf-page-path">{data.path}</span>
          )}
        </div>
        {isAuth && <span className="tf-page-auth-badge">🔒</span>}
      </div>

      {data.navType && (
        <div className="tf-page-nav-type">
          {data.navType === 'tab' ? 'Tab' : data.navType === 'stack' ? 'Screen' : 'Route'}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: '#58a6ff', border: 'none', width: 6, height: 6 }}
      />
    </div>
  );
}

export default memo(PageNode);
