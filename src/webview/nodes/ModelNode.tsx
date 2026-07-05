// src/webview/nodes/ModelNode.tsx
// Custom ReactFlow node for Django model display (table-like card)

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export interface ModelNodeData {
  name: string;
  fields: string[];
}

function ModelNode({ data }: NodeProps<ModelNodeData>) {
  // Show at most 8 fields, then "... +N more"
  const MAX_FIELDS = 8;
  const visibleFields = data.fields.slice(0, MAX_FIELDS);
  const remaining = data.fields.length - MAX_FIELDS;

  return (
    <div className="tf-node tf-model-node">
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: '#7ee787', border: 'none', width: 6, height: 6 }}
      />

      <div className="tf-model-header">
        <span className="tf-model-icon">📋</span>
        <span className="tf-model-name">{data.name}</span>
      </div>

      <div className="tf-model-fields">
        {visibleFields.map((field, i) => {
          // field can be "name: CharField" or just "name"
          const parts = field.split(': ');
          return (
            <div key={i} className="tf-model-field">
              <span className="tf-model-field-name">{parts[0]}</span>
              {parts[1] && (
                <span className="tf-model-field-type">: {parts[1]}</span>
              )}
            </div>
          );
        })}
        {remaining > 0 && (
          <div className="tf-model-field" style={{ color: '#6e7681', fontStyle: 'italic' }}>
            … +{remaining} more
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: '#7ee787', border: 'none', width: 6, height: 6 }}
      />
    </div>
  );
}

export default memo(ModelNode);
