import type {PoseAsset} from '../../pose/types'
import type {Anime25DParameterState, MouthMorphProfile} from './types'
import type {MouthLevel} from '../../character-chat/PlaybackMouthMeter'
import {isValidMouthMorphProfile, mouthMorphWeights} from './MouthMorph'

/** Use this pose's own genuinely closed artwork; preserve its normal expression. */
export function speechClosedExpression(profile: MouthMorphProfile): 'neutral' | 'smile' | null {
 if (!isValidMouthMorphProfile(profile)) return null
 return (['neutral', 'smile'] as const).find(expression => profile[expression].lower.every((value, i) => Math.abs(value-profile[expression].upper[i]) < .0001)) ?? null
}
export function speechMouthWeights(open: number, profile: MouthMorphProfile) {
 const closed = speechClosedExpression(profile)
 if (!closed) return mouthMorphWeights(open, 0, profile)
 const weights = mouthMorphWeights(open, 0)
 return {aperture: weights.aperture, neutral: closed === 'neutral' ? weights.neutral : 0, smile: closed === 'smile' ? weights.neutral : 0, open: weights.open}
}
/** Never affect base art, partial swaps, transitions, or a rig without authored mouth art. */
export function audioMouthParameters(parameters: Anime25DParameterState, level: MouthLevel | null, asset: PoseAsset | null, state: string, crossfade: boolean): Anime25DParameterState {
 if (level === null || state !== 'ACTIVE_LOOP' || crossfade || asset?.manifest.audioLipSync !== 'amplitude-3' || asset.manifest.strategy !== 'independent-model') return parameters
 const rig = asset.result.model.rig, profile = rig.anchors.mouth.speechMorph ?? rig.anchors.mouth.morph
 const closed = profile && speechClosedExpression(profile)
 if (!closed || ![closed, 'open'].every(expression => rig.layers.some(layer => layer.mouthExpression === expression))) return parameters
 return {...parameters, mouthOpen: [0, .30, .70][level], mouthForm: 0, mouthEase: 0}
}

/** Select only the current authored mouth artwork, never face/jaw/head or outgoing/base layers. */
export function mouthLayerParameters<T extends Anime25DParameterState>(layer:{mouthExpression?:string;pose?:boolean;outgoing?:boolean;independent?:unknown},parameters:T,mouth:Anime25DParameterState|null):T {
 return mouth&&layer.mouthExpression&&layer.pose&&!layer.outgoing&&layer.independent ? {...parameters,mouthOpen:mouth.mouthOpen,mouthForm:mouth.mouthForm,mouthEase:mouth.mouthEase} : parameters
}
