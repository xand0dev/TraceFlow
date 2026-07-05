// src/webview/nodes/EndpointNode.tsx
// Custom ReactFlow node for API endpoint display (compact pill)

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export interface EndpointNodeData {
  path: string;
  methods: string[];
  view: string;
  endpointType?: string;
}

function EndpointNode({ data }: NodeProps<EndpointNodeData>) {
  // Show the primary method (first one)
  const primaryMethod = data.methods?.[0] || 'GET';

  return (
    <div className="tf-node tf-endpoint-node">
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: '#79c0ff', border: 'none', width: 6, height: 6 }}
      />

      <div className="tf-endpoint-header">
        <span className={`tf-endpoint-method ${primaryMethod}`}>
          {data.methods?.join(' / ') || 'GET'}
        </span>
        <span className="tf-endpoint-path">{data.path}</span>
      </div>
      {data.view && data.view !== 'unknown' && (
        <div className="tf-endpoint-view">→ {data.view}</div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: '#79c0ff', border: 'none', width: 6, height: 6 }}
      />
    </div>
  );
}

export default memo(EndpointNode);
