// src/webview/nodes/ServiceNode.tsx
// Custom ReactFlow node for service-level blocks (Frontend, Backend, DB)
// Supports expand/collapse with summary stats when collapsed.

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export interface ServiceNodeData {
  label: string;
  serviceType: 'frontend' | 'backend' | 'database';
  subtitle?: string;
  expanded?: boolean;
  endpointCount?: number;
  modelCount?: number;
  onToggleExpand?: () => void;
}

const ICONS: Record<string, string> = {
  frontend: '🖥️',
  backend: '⚙️',
  database: '🗄️',
};

const TYPE_LABELS: Record<string, string> = {
  frontend: 'CLIENT',
  backend: 'SERVER',
  database: 'DATA STORE',
};

function ServiceNode({ data }: NodeProps<ServiceNodeData>) {
  const icon = ICONS[data.serviceType] || '📦';
  const typeLabel = TYPE_LABELS[data.serviceType] || 'SERVICE';
  const isExpandable = (data.endpointCount ?? 0) > 0 || (data.modelCount ?? 0) > 0;
  const isExpanded = data.expanded ?? false;

  return (
    <div
      className={`tf-node tf-service-node ${data.serviceType} ${isExpanded ? 'expanded' : ''} ${isExpandable ? 'expandable' : ''}`}
      onClick={(e) => {
        if (isExpandable && data.onToggleExpand) {
          e.stopPropagation();
          data.onToggleExpand();
        }
      }}
    >
      {/* Input handle — top */}
      {data.serviceType !== 'frontend' && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: '#58a6ff', border: 'none', width: 8, height: 8 }}
        />
      )}

      <div className="tf-service-header">
        <span className="tf-service-icon">{icon}</span>
        <div className="tf-service-info">
          <span className="tf-service-name">{data.label}</span>
          <span className="tf-service-type">{data.subtitle || typeLabel}</span>
        </div>
        {isExpandable && (
          <span className={`tf-service-chevron ${isExpanded ? 'open' : ''}`}>
            ▾
          </span>
        )}
      </div>

      {/* Summary stats — visible when collapsed */}
      {isExpandable && !isExpanded && (
        <div className="tf-service-stats">
          {(data.endpointCount ?? 0) > 0 && (
            <span className="tf-stat-badge endpoint-badge">
              🔗 {data.endpointCount} endpoints
            </span>
          )}
          {(data.modelCount ?? 0) > 0 && (
            <span className="tf-stat-badge model-badge">
              📋 {data.modelCount} models
            </span>
          )}
          <span className="tf-expand-hint">click to expand</span>
        </div>
      )}

      {/* Output handle — bottom */}
      {data.serviceType !== 'database' && (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: '#58a6ff', border: 'none', width: 8, height: 8 }}
        />
      )}
    </div>
  );
}

export default memo(ServiceNode);
