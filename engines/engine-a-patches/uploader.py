# FILE: src/uploader.py — DYPOL-patched replacement
# Replace YOUR FORK's src/uploader.py with this file.
#
# Changes vs upstream (see engines/engine-a-patches/code_patches.md):
#   1. Visibility comes from YOUTUBE_PRIVACY_STATUS (default 'private' — never
#      hard-coded 'public'). The exact videos.insert body is verified against
#      the requested visibility immediately before the API call.
#   2. Returns a full video RECORD dict (id, url, visibility, title) instead of
#      a bare id, so main.py can record BOTH the long-form and the Short upload
#      separately — the second upload never overwrites the first.
#   3. Secrets/credentials are never printed.

import os
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from dypol_control import (  # repo-root module (see code_patches.md)
    build_insert_body,
    verify_insert_body,
    VALID_VISIBILITY,
)

CLIENT_SECRETS_FILE = Path('client_secrets.json')
CREDENTIALS_FILE = Path('credentials.json')
YOUTUBE_UPLOAD_SCOPE = ["https://www.googleapis.com/auth/youtube.upload"]


def sanitize_title(title: str | None, max_length: int = 100) -> str:
    """Return a YouTube-safe title that is non-empty and within the API limit."""
    clean_title = str(title or "").replace("&lt;", "").replace("&gt;", "").replace("<", "").replace(">", "").strip()
    if not clean_title:
        clean_title = "Untitled Video"
    if len(clean_title) > max_length:
        if max_length <= 3:
            return clean_title[:max_length]
        clean_title = clean_title[: max_length - 3].rstrip() + "..."
    return clean_title


def get_privacy_status() -> str:
    """Visibility for uploads. Defaults to 'private' — test uploads must never
    become public by accident. The console dispatches this explicitly."""
    vis = str(os.environ.get("YOUTUBE_PRIVACY_STATUS", "private") or "private").strip().lower()
    if vis not in VALID_VISIBILITY:
        print(f"WARNING: invalid YOUTUBE_PRIVACY_STATUS={vis!r} — falling back to 'private'.")
        vis = "private"
    return vis


def get_authenticated_service():
    """OAuth2 flow, identical contract to upstream (local + GitHub Actions)."""
    credentials = None
    if CREDENTIALS_FILE.exists():
        print("INFO: Found existing credentials file.")
        credentials = Credentials.from_authorized_user_file(str(CREDENTIALS_FILE), YOUTUBE_UPLOAD_SCOPE)

    if not credentials or not credentials.valid:
        if credentials and credentials.expired and credentials.refresh_token:
            print("INFO: Refreshing expired credentials...")
            credentials.refresh(Request())
        else:
            print("INFO: No valid credentials found. Starting new authentication flow...")
            if not CLIENT_SECRETS_FILE.exists():
                raise FileNotFoundError(
                    f"CRITICAL ERROR: {CLIENT_SECRETS_FILE} not found. "
                    "Please download it from Google Cloud Console."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRETS_FILE), scopes=YOUTUBE_UPLOAD_SCOPE)
            credentials = flow.run_local_server(port=0)
        with open(CREDENTIALS_FILE, 'w') as f:
            f.write(credentials.to_json())
        print(f"INFO: Credentials saved to {CREDENTIALS_FILE}")

    return build('youtube', 'v3', credentials=credentials)


def upload_to_youtube(video_path, title, description, tags, thumbnail_path=None, kind: str = "video"):
    """Upload one video to YouTube and return its FULL RECORD.

    Returns:
        {"youtube_id", "youtube_url", "title", "visibility", "kind", "thumbnail_uploaded"}

    The record (not a bare id) is what main.py persists via
    dypol_control.record_upload_results, keeping long-form and Short uploads
    separate. Raises on failure — callers must not treat failures as success.
    """
    sanitized_title = sanitize_title(title)
    visibility = get_privacy_status()
    print(f"⬆️ Uploading '{video_path}' to YouTube with title: {sanitized_title!r} (visibility={visibility})")

    youtube = get_authenticated_service()

    # Build + VERIFY the exact request body before touching the API:
    # this is the videos.insert gate that guarantees the requested privacy.
    request_body = build_insert_body(sanitized_title, description, tags, visibility)
    verify_insert_body(request_body, visibility)
    print(f"🔒 videos.insert body verified: privacyStatus={request_body['status']['privacyStatus']!r}")

    media = MediaFileUpload(str(video_path), chunksize=-1, resumable=True)
    request = youtube.videos().insert(
        part=','.join(request_body.keys()),
        body=request_body,
        media_body=media
    )

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"Uploaded {int(status.progress() * 100)}%.")

    video_id = (response or {}).get('id')
    if not video_id:
        raise RuntimeError("YouTube API returned success without a video id — upload state unknown; refusing to guess.")
    print(f"✅ Video uploaded successfully! Video ID: {video_id} (visibility={visibility})")

    thumbnail_uploaded = False
    if thumbnail_path and os.path.exists(thumbnail_path):
        print(f"⬆️ Uploading thumbnail '{thumbnail_path}' for video ID: {video_id}...")
        try:
            thumbnail_media = MediaFileUpload(str(thumbnail_path))
            youtube.thumbnails().set(videoId=video_id, media_body=thumbnail_media).execute()
            thumbnail_uploaded = True
            print("✅ Thumbnail uploaded successfully!")
        except Exception as e:  # thumbnail failure must not lose the video record
            print(f"❌ ERROR: Failed to upload thumbnail (video itself is safe, id={video_id}): {e}")
    else:
        print("⚠️ No thumbnail path provided or thumbnail file does not exist. Skipping thumbnail upload.")

    return {
        "youtube_id": video_id,
        "youtube_url": f"https://youtu.be/{video_id}",
        "title": sanitized_title,
        "visibility": visibility,
        "kind": kind,
        "thumbnail_uploaded": thumbnail_uploaded,
    }
