import type {PoseAsset} from '../../pose/types'
import type {Anime25DParameterState} from './types'
import type {MouthLevel} from '../../character-chat/PlaybackMouthMeter'
/** Never affect base art, partial swaps, transitions, or a rig without authored mouth art. */
export function audioMouthParameters(parameters: Anime25DParameterState, level: MouthLevel | null, asset: PoseAsset | null, state: string, crossfade: boolean): Anime25DParameterState {
 if (level === null || state !== 'ACTIVE_LOOP' || crossfade || asset?.manifest.audioLipSync !== 'amplitude-3' || asset.manifest.strategy !== 'independent-model') return parameters
 const rig = asset.result.model.rig
 if (!rig.anchors.mouth.morph || !['neutral','open'].every(expression => rig.layers.some(layer => layer.mouthExpression === expression))) return parameters
 return {...parameters, mouthOpen: [0, .30, .70][level], mouthForm: 0, mouthEase: 0}
}

/** Select only the current authored mouth artwork, never face/jaw/head or outgoing/base layers. */
export function mouthLayerParameters<T extends Anime25DParameterState>(layer:{mouthExpression?:string;pose?:boolean;outgoing?:boolean;independent?:unknown},parameters:T,mouth:Anime25DParameterState|null):T {
 return mouth&&layer.mouthExpression&&layer.pose&&!layer.outgoing&&layer.independent ? {...parameters,mouthOpen:mouth.mouthOpen,mouthForm:mouth.mouthForm,mouthEase:mouth.mouthEase} : parameters
}
