const vertexShader = /* glsl */ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    uniform highp usampler2D transformA;                // splat center x, y, z
    uniform sampler2D transformB;                       // splat scale (log)
    uniform highp usampler2D splatTransform;            // transform palette index
    uniform sampler2D transformPalette;                 // palette of transforms
    uniform sampler2D splatState;                       // per-splat state
    uniform highp ivec3 splat_params;                   // texture width, texture height, num splats
    uniform highp uint mode;                            // 0: selected, 1: visible

    // calculate min and max for a single column of splats
    void main(void) {

        vec3 boundMin = vec3(1e6);
        vec3 boundMax = vec3(-1e6);

        for (int id = 0; id < splat_params.y; id++) {
            // calculate splatUV
            ivec2 splatUV = ivec2(gl_FragCoord.x, id);

            // skip out-of-range splats
            if ((splatUV.x + splatUV.y * splat_params.x) >= splat_params.z) {
                continue;
            }

            // read splat state
            uint state = uint(texelFetch(splatState, splatUV, 0).r * 255.0);

            // skip deleted or locked splats
            if (((mode == 0u) && (state != 1u)) || ((mode == 1u) && ((state & 4u) != 0u))) {
                continue;
            }

            // read splat center and scale (log space)
            vec3 center = uintBitsToFloat(texelFetch(transformA, splatUV, 0).xyz);
            vec3 scale = texelFetch(transformB, splatUV, 0).xyz;

            // ignore invalid data
            bvec3 centerInf = isinf(center);
            bvec3 scaleInf = isinf(scale);
            bvec3 centerNan = isnan(center);
            bvec3 scaleNan = isnan(scale);
            if (any(centerInf) || any(scaleInf) || any(centerNan) || any(scaleNan)) {
                continue;
            }

            // start with a conservative sphere radius derived from the largest axis
            float radius = 2.0 * exp(max(scale.x, max(scale.y, scale.z)));

            // apply optional per-splat transform and track scale contribution
            uint transformIndex = texelFetch(splatTransform, splatUV, 0).r;
            if (transformIndex > 0u) {
                // read transform matrix
                int u = int(transformIndex % 512u) * 3;
                int v = int(transformIndex / 512u);

                mat3x4 t;
                t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
                t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
                t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);

                center = vec4(center, 1.0) * t;

                // radius needs to be scaled by the maximum row length of the linear part
                vec3 row0 = vec3(t[0].x, t[1].x, t[2].x);
                vec3 row1 = vec3(t[0].y, t[1].y, t[2].y);
                vec3 row2 = vec3(t[0].z, t[1].z, t[2].z);
                float paletteScale = max(length(row0), max(length(row1), length(row2)));
                radius *= paletteScale;
            }

            vec3 extent = vec3(radius);
            vec3 minPos = center - extent;
            vec3 maxPos = center + extent;

            boundMin = min(boundMin, minPos);
            boundMax = max(boundMax, maxPos);
        }

        pcFragColor0 = vec4(boundMin, 0.0);
        pcFragColor1 = vec4(boundMax, 0.0);
    }
`;

export { vertexShader, fragmentShader };
