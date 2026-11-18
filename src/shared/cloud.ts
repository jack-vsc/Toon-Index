/** The sync over the internet through the person's Firebase project (main/cloud.ts). */

export interface CloudConfig {
  /** The console's firebaseConfig block (the web app's). */
  web: { apiKey: string; authDomain?: string; projectId: string; storageBucket?: string; messagingSenderId: string; appId: string }
  /** The Android app's id in the same project, for the phone. */
  androidAppId: string
}

export interface CloudStatus {
  configured: boolean
  connected: boolean
  error: string | null
  /** Phones that joined (paired at home since the sync was on). */
  members: number
  /** The project's service key is kept: new chapters go to the phones as notifications. */
  push: boolean
}

/** The Firestore security rules: only the members of a space read or write it. */
export const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /spaces/{space} {
      allow create: if request.auth != null && request.resource.data.members == [request.auth.uid];
      allow read, update: if request.auth != null && request.auth.uid in resource.data.members;
      match /{rest=**} {
        allow read, write: if request.auth != null
          && request.auth.uid in get(/databases/$(database)/documents/spaces/$(space)).data.members;
      }
    }
  }
}`
