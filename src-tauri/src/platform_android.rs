// ============================================================
// Android 存储桥（仅在 target_os = "android" 编译）
// 默认目录：MediaStore.Downloads（API 29+，无需 WRITE_EXTERNAL_STORAGE）
// 自定义目录：Download 子目录使用 MediaStore.relative_path；历史 SAF URI 仍兼容
// API 28 及以下：Environment 公共 Download 目录（配合 manifest maxSdkVersion=28）
// ============================================================
use jni::objects::*;
use jni::sys::jsize;
use jni::{JNIEnv, JavaVM};
use std::fs::File;
use std::io::Read;
use std::os::fd::RawFd;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use crate::{native_log, SavedFile};
use tauri::AppHandle;

const DOWNLOADS_COLLECTION: &str = "content://media/external/downloads";
const DOWNLOADS_SUBDIR_PREFIX: &str = "android-downloads://";
const WRITE_CHUNK: usize = 512 * 1024; // 限制单次写入，降低 Android 内存峰值
const MEDIA_IS_PENDING: &str = "is_pending";

#[derive(Clone)]
struct AndroidBridge {
    vm: Arc<JavaVM>,
    application: GlobalRef,
}

static ANDROID_BRIDGE: OnceLock<Mutex<Option<AndroidBridge>>> = OnceLock::new();

fn android_bridge() -> &'static Mutex<Option<AndroidBridge>> {
    ANDROID_BRIDGE.get_or_init(|| Mutex::new(None))
}

/// 由 MainActivity.onCreate 注册 JavaVM 和 Application Context。
/// Tauri Android 不保证 ndk-context 全局状态已初始化，因此不能依赖它获取 JNI。
#[no_mangle]
pub extern "system" fn Java_com_mptrace_app_MainActivity_initNativeContext(
    mut env: JNIEnv,
    _this: JObject,
    activity: JObject,
) {
    let result = (|| -> Result<(), String> {
        let vm = env
            .get_java_vm()
            .map_err(|e| format!("获取 Android JVM 失败：{e}"))?;
        let application = env
            .call_method(
                &activity,
                "getApplicationContext",
                "()Landroid/content/Context;",
                &[],
            )
            .map_err(|e| format!("获取 Application Context 失败：{e}"))?
            .l()
            .map_err(|e| format!("解析 Application Context 失败：{e}"))?;
        if application.is_null() {
            return Err("Application Context 为空".to_string());
        }
        let application = env
            .new_global_ref(&application)
            .map_err(|e| format!("保存 Application Context 失败：{e}"))?;
        let mut bridge = android_bridge()
            .lock()
            .map_err(|_| "Android Context 桥接锁已损坏".to_string())?;
        *bridge = Some(AndroidBridge {
            vm: Arc::new(vm),
            application,
        });
        Ok(())
    })();

    if let Err(error) = result {
        eprintln!("MPTrace Android Context 初始化失败：{error}");
    }
}

fn android_download_subdir(dir: &str) -> Option<String> {
    let raw = dir.strip_prefix(DOWNLOADS_SUBDIR_PREFIX)?;
    let decoded = percent_decode(raw);
    let clean = decoded
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>();
    if clean.is_empty() {
        None
    } else {
        Some(clean.join("/"))
    }
}

fn percent_decode(value: &str) -> String {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn download_display(subdir: Option<&str>, name: &str) -> String {
    match subdir {
        Some(path) => format!("公共下载目录 Download/{path}/{name}"),
        None => format!("公共下载目录 Download/{name}"),
    }
}

fn set_download_relative_path<'a>(
    env: &mut JNIEnv<'a>,
    values: &JObject<'a>,
    subdir: Option<&str>,
) -> Result<(), String> {
    let relative = match subdir {
        Some(path) => format!("Download/{path}/"),
        None => "Download/".to_string(),
    };
    cv_put(env, values, "relative_path", &relative)
}

// ---------------- 入口 ----------------

pub fn save(dir: &str, name: &str, mime: &str, bytes: &[u8]) -> Result<SavedFile, String> {
    with_env(|env| {
        let activity = current_context(env)?;
        let sdk = sdk_int(env)?;
        let download_subdir = android_download_subdir(dir);
        if dir.starts_with("content://") && dir != DOWNLOADS_COLLECTION && download_subdir.is_none()
        {
            save_via_saf(env, &activity, dir, name, mime, bytes)
        } else if sdk >= 29 {
            save_via_mediastore(
                env,
                &activity,
                name,
                mime,
                bytes,
                download_subdir.as_deref(),
            )
        } else {
            save_via_external_legacy(env, &activity, name, bytes)
        }
    })
}

/// 从临时文件流式写入 Android 目标目录，避免在传输完成时一次性读取整个文件。
pub fn save_file_from_path(
    app: &AppHandle,
    dir: &str,
    name: &str,
    mime: &str,
    source: &Path,
) -> Result<SavedFile, String> {
    native_log(
        app,
        format!(
            "android.save.begin name={name} mime={mime} dir={dir} source={} source_size={}",
            source.display(),
            std::fs::metadata(source).map(|m| m.len()).unwrap_or(0)
        ),
    );
    let result = with_env_logged(app, |env| {
        native_log(app, "android.save.context.begin");
        let activity = current_context(env)?;
        native_log(app, "android.save.context.ok");
        let sdk = sdk_int(env)?;
        native_log(app, format!("android.save.sdk.ok sdk={sdk}"));
        let download_subdir = android_download_subdir(dir);
        native_log(
            app,
            format!(
                "android.save.route sdk={sdk} subdir={:?} saf={}",
                download_subdir,
                dir.starts_with("content://")
                    && dir != DOWNLOADS_COLLECTION
                    && download_subdir.is_none()
            ),
        );
        if dir.starts_with("content://") && dir != DOWNLOADS_COLLECTION && download_subdir.is_none()
        {
            save_via_saf_path(env, &activity, dir, name, mime, source)
        } else if sdk >= 29 {
            save_via_mediastore_path(
                app,
                env,
                &activity,
                name,
                mime,
                source,
                download_subdir.as_deref(),
            )
        } else {
            save_via_external_legacy_path(env, &activity, name, source)
        }
    });
    match &result {
        Ok(saved) => native_log(
            app,
            format!(
                "android.save.ok uri={} display={}",
                saved.uri, saved.display
            ),
        ),
        Err(err) => native_log(app, format!("android.save.failed error={err}")),
    }
    result
}
/// 对 SAF 目录申请持久化读写授权（应用重启后仍有效）
pub fn persist_tree_uri(uri_str: &str) -> Result<(), String> {
    with_env(|env| {
        let activity = current_context(env)?;
        let resolver = content_resolver(env, &activity)?;
        let uri = parse_uri(env, uri_str)?;
        // FLAG_GRANT_READ_URI_PERMISSION(1) | FLAG_GRANT_WRITE_URI_PERMISSION(2) = 3
        let _ = env.call_method(
            &resolver,
            "takePersistableUriPermission",
            "(Landroid/net/Uri;I)V",
            &[JValue::Object(&uri), JValue::Int(3)],
        );
        let _ = env.exception_clear();
        Ok(())
    })
}

// ---------------- MediaStore Downloads（API 29+） ----------------

fn save_via_mediastore<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
    name: &str,
    mime: &str,
    bytes: &[u8],
    subdir: Option<&str>,
) -> Result<SavedFile, String> {
    let resolver = content_resolver(env, activity)?;
    let dl_class = env
        .find_class("android/provider/MediaStore$Downloads")
        .map_err(|e| format!("找不到 MediaStore.Downloads：{e}"))?;
    let collection = env
        .get_static_field(&dl_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    let cv_class = env
        .find_class("android/content/ContentValues")
        .map_err(|e| e.to_string())?;
    let values = env
        .new_object(&cv_class, "<init>", &[])
        .map_err(|e| e.to_string())?;
    cv_put(env, &values, "display_name", name)?;
    cv_put(env, &values, "mime_type", mime)?;
    set_download_relative_path(env, &values, subdir)?;
    cv_put_i32(env, &values, MEDIA_IS_PENDING, 1)?;

    let uri = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[JValue::Object(&collection), JValue::Object(&values)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    catch_exc(env, "MediaStore.insert")?;
    if uri.is_null() {
        return Err("系统拒绝创建下载文件".to_string());
    }
    if let Err(err) = write_via_output_stream(env, &resolver, &uri, bytes) {
        let _ = delete_uri(env, &resolver, &uri);
        return Err(err);
    }
    if let Err(err) = publish_media_store_file(env, &resolver, &uri) {
        let _ = delete_uri(env, &resolver, &uri);
        return Err(err);
    }
    let uri_str = object_to_string(env, &uri)?;
    Ok(SavedFile {
        uri: uri_str,
        display: download_display(subdir, name),
    })
}

fn save_via_mediastore_path<'a>(
    app: &AppHandle,
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
    name: &str,
    mime: &str,
    source: &Path,
    subdir: Option<&str>,
) -> Result<SavedFile, String> {
    native_log(app, "android.mediastore.begin");
    let resolver = content_resolver(env, activity)?;
    let dl_class = env
        .find_class("android/provider/MediaStore$Downloads")
        .map_err(|e| e.to_string())?;
    let collection = env
        .get_static_field(&dl_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let cv_class = env
        .find_class("android/content/ContentValues")
        .map_err(|e| e.to_string())?;
    let values = env
        .new_object(&cv_class, "<init>", &[])
        .map_err(|e| e.to_string())?;
    cv_put(env, &values, "display_name", name)?;
    cv_put(env, &values, "mime_type", mime)?;
    set_download_relative_path(env, &values, subdir)?;
    cv_put_i32(env, &values, MEDIA_IS_PENDING, 1)?;
    let uri = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[JValue::Object(&collection), JValue::Object(&values)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    catch_exc(env, "MediaStore.insert")?;
    native_log(
        app,
        format!("android.mediastore.insert uri_null={}", uri.is_null()),
    );
    if uri.is_null() {
        return Err("系统拒绝创建下载文件".to_string());
    }
    native_log(app, "android.mediastore.write.begin");
    if let Err(err) = write_file_via_output_stream(env, &resolver, &uri, source) {
        native_log(app, format!("android.mediastore.write.failed error={err}"));
        let _ = delete_uri(env, &resolver, &uri);
        return Err(err);
    }
    native_log(app, "android.mediastore.write.ok");
    native_log(app, "android.mediastore.publish.begin");
    if let Err(err) = publish_media_store_file(env, &resolver, &uri) {
        native_log(
            app,
            format!("android.mediastore.publish.failed error={err}"),
        );
        let _ = delete_uri(env, &resolver, &uri);
        return Err(err);
    }
    native_log(app, "android.mediastore.publish.ok");
    Ok(SavedFile {
        uri: object_to_string(env, &uri)?,
        display: download_display(subdir, name),
    })
}
// ---------------- SAF 用户自选目录 ----------------

fn save_via_saf<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
    tree_uri: &str,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<SavedFile, String> {
    let resolver = content_resolver(env, activity)?;
    let tree = parse_uri(env, tree_uri)?;
    // 再尝试一次持久化授权，失败不阻断（目录选择器通常已授权）
    let _ = env.call_method(
        &resolver,
        "takePersistableUriPermission",
        "(Landroid/net/Uri;I)V",
        &[JValue::Object(&tree), JValue::Int(3)],
    );
    let _ = env.exception_clear();

    let dc = env
        .find_class("android/provider/DocumentsContract")
        .map_err(|e| e.to_string())?;
    let tree_id = env
        .call_static_method(
            &dc,
            "getTreeDocumentId",
            "(Landroid/net/Uri;)Ljava/lang/String;",
            &[JValue::Object(&tree)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let parent = env
        .call_static_method(
            &dc,
            "buildDocumentUriUsingTree",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&tree), JValue::Object(&tree_id)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // 同名自动追加序号，最多尝试 30 次
    let mut child = JObject::null();
    let mut final_name = name.to_string();
    for attempt in 0..30 {
        let mime_obj: JObject = env.new_string(mime).map_err(|e| e.to_string())?.into();
        let name_obj: JObject = env
            .new_string(&final_name)
            .map_err(|e| e.to_string())?
            .into();
        let _ = env.exception_clear();
        let result = env.call_static_method(
            &dc,
            "createDocument",
            "(Landroid/content/ContentResolver;Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;",
            &[
                JValue::Object(&resolver),
                JValue::Object(&parent),
                JValue::Object(&mime_obj),
                JValue::Object(&name_obj),
            ],
        );
        match result {
            Ok(v) => {
                child = v.l().map_err(|e| e.to_string())?;
                if !child.is_null() {
                    break;
                }
            }
            Err(_) => {
                let _ = env.exception_clear();
            }
        }
        final_name = suffix_name(name, attempt + 1);
    }
    if child.is_null() {
        return Err("SAF 创建文件失败：可能无目录权限或同名文件过多".to_string());
    }
    write_via_output_stream(env, &resolver, &child, bytes)?;
    let uri_str = object_to_string(env, &child)?;
    let dir_tail = tree_uri
        .rsplit('/')
        .next()
        .unwrap_or("已选目录")
        .replace("%3A", ":")
        .replace("%2F", "/");
    Ok(SavedFile {
        uri: uri_str,
        display: format!("{dir_tail}/{final_name}"),
    })
}

fn save_via_saf_path<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
    tree_uri: &str,
    name: &str,
    mime: &str,
    source: &Path,
) -> Result<SavedFile, String> {
    let resolver = content_resolver(env, activity)?;
    let tree = parse_uri(env, tree_uri)?;
    let _ = env.call_method(
        &resolver,
        "takePersistableUriPermission",
        "(Landroid/net/Uri;I)V",
        &[JValue::Object(&tree), JValue::Int(3)],
    );
    let _ = env.exception_clear();
    let dc = env
        .find_class("android/provider/DocumentsContract")
        .map_err(|e| e.to_string())?;
    let tree_id = env
        .call_static_method(
            &dc,
            "getTreeDocumentId",
            "(Landroid/net/Uri;)Ljava/lang/String;",
            &[JValue::Object(&tree)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let parent = env
        .call_static_method(
            &dc,
            "buildDocumentUriUsingTree",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&tree), JValue::Object(&tree_id)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let mut child = JObject::null();
    let mut final_name = name.to_string();
    for attempt in 0..30 {
        let mime_obj: JObject = env.new_string(mime).map_err(|e| e.to_string())?.into();
        let name_obj: JObject = env
            .new_string(&final_name)
            .map_err(|e| e.to_string())?
            .into();
        let _ = env.exception_clear();
        match env.call_static_method(
            &dc,
            "createDocument",
            "(Landroid/content/ContentResolver;Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&resolver), JValue::Object(&parent), JValue::Object(&mime_obj), JValue::Object(&name_obj)],
        ) {
            Ok(v) => {
                child = v.l().map_err(|e| e.to_string())?;
                if !child.is_null() { break; }
            }
            Err(_) => { let _ = env.exception_clear(); }
        }
        final_name = suffix_name(name, attempt + 1);
    }
    if child.is_null() {
        return Err("SAF 创建文件失败".to_string());
    }
    write_file_via_output_stream(env, &resolver, &child, source)?;
    Ok(SavedFile {
        uri: object_to_string(env, &child)?,
        display: format!("SAF/{final_name}"),
    })
}
// ---------------- API 28 及以下兜底：公共 Download ----------------

fn save_via_external_legacy<'a>(
    env: &mut JNIEnv<'a>,
    _activity: &JObject<'a>,
    name: &str,
    bytes: &[u8],
) -> Result<SavedFile, String> {
    let env_class = env
        .find_class("android/os/Environment")
        .map_err(|e| e.to_string())?;
    let kind: JObject = env
        .new_string("Download")
        .map_err(|e| e.to_string())?
        .into();
    let dir = env
        .call_static_method(
            &env_class,
            "getExternalStoragePublicDirectory",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[JValue::Object(&kind)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    let name_obj: JObject = env.new_string(name).map_err(|e| e.to_string())?.into();
    let file_class = env.find_class("java/io/File").map_err(|e| e.to_string())?;
    let file = env
        .new_object(
            &file_class,
            "<init>",
            &[JValue::Object(&dir), JValue::Object(&name_obj)],
        )
        .map_err(|e| e.to_string())?;

    let fos_class = env
        .find_class("java/io/FileOutputStream")
        .map_err(|e| e.to_string())?;
    let stream = env
        .new_object(&fos_class, "<init>", &[JValue::Object(&file)])
        .map_err(|e| e.to_string())?;
    catch_exc(env, "FileOutputStream")?;
    let write_result = write_bytes_to_stream(env, &stream, bytes);
    let close_result = close_output_stream(env, &stream);
    write_result.and(close_result)?;
    Ok(SavedFile {
        uri: format!("/sdcard/Download/{name}"),
        display: format!("公共下载目录 Download/{name}"),
    })
}

fn save_via_external_legacy_path<'a>(
    env: &mut JNIEnv<'a>,
    _activity: &JObject<'a>,
    name: &str,
    source: &Path,
) -> Result<SavedFile, String> {
    let env_class = env
        .find_class("android/os/Environment")
        .map_err(|e| e.to_string())?;
    let kind: JObject = env
        .new_string("Download")
        .map_err(|e| e.to_string())?
        .into();
    let dir = env
        .call_static_method(
            &env_class,
            "getExternalStoragePublicDirectory",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[JValue::Object(&kind)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let name_obj: JObject = env.new_string(name).map_err(|e| e.to_string())?.into();
    let file_class = env.find_class("java/io/File").map_err(|e| e.to_string())?;
    let file = env
        .new_object(
            &file_class,
            "<init>",
            &[JValue::Object(&dir), JValue::Object(&name_obj)],
        )
        .map_err(|e| e.to_string())?;
    let fos_class = env
        .find_class("java/io/FileOutputStream")
        .map_err(|e| e.to_string())?;
    let stream = env
        .new_object(&fos_class, "<init>", &[JValue::Object(&file)])
        .map_err(|e| e.to_string())?;
    catch_exc(env, "FileOutputStream")?;
    let write_result = write_file_to_stream(env, &stream, source);
    let close_result = close_output_stream(env, &stream);
    write_result.and(close_result)?;
    Ok(SavedFile {
        uri: format!("/sdcard/Download/{name}"),
        display: format!("公共下载目录 Download/{name}"),
    })
}
// ---------------- 通用 JNI 工具 ----------------

fn open_parcel_file_descriptor<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
) -> Result<(JObject<'a>, RawFd), String> {
    let mode: JObject = env.new_string("w").map_err(|e| e.to_string())?.into();
    let pfd = env
        .call_method(
            resolver,
            "openFileDescriptor",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
            &[JValue::Object(uri), JValue::Object(&mode)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    catch_exc(env, "openFileDescriptor")?;
    if pfd.is_null() {
        return Err("Android 无法打开目标文件".to_string());
    }
    let fd = env
        .call_method(&pfd, "getFd", "()I", &[])
        .map_err(|e| e.to_string())?
        .i()
        .map_err(|e| e.to_string())?;
    catch_exc(env, "ParcelFileDescriptor.getFd")?;
    let dup_fd = unsafe { libc::dup(fd) };
    if dup_fd < 0 {
        return Err("复制 Android 文件描述符失败".to_string());
    }
    Ok((pfd, dup_fd))
}

fn close_parcel_file_descriptor<'a>(env: &mut JNIEnv<'a>, pfd: &JObject<'a>) -> Result<(), String> {
    env.call_method(pfd, "close", "()V", &[])
        .map_err(|e| e.to_string())?;
    catch_exc(env, "ParcelFileDescriptor.close")
}

fn open_output_stream<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
) -> Result<JObject<'a>, String> {
    let mode: JObject = env.new_string("w").map_err(|e| e.to_string())?.into();
    let result = env.call_method(
        resolver,
        "openOutputStream",
        "(Landroid/net/Uri;Ljava/lang/String;)Ljava/io/OutputStream;",
        &[JValue::Object(uri), JValue::Object(&mode)],
    );
    let value = match result {
        Ok(value) => value,
        Err(err) => {
            let detail = err.to_string();
            let _ = catch_exc(env, "openOutputStream");
            return Err(format!("Android 无法打开目标文件写入流：{detail}"));
        }
    };
    let stream = value.l().map_err(|e| e.to_string())?;
    catch_exc(env, "openOutputStream")?;
    if stream.is_null() {
        return Err("Android 无法打开目标文件写入流".to_string());
    }
    Ok(stream)
}

fn close_output_stream<'a>(env: &mut JNIEnv<'a>, stream: &JObject<'a>) -> Result<(), String> {
    if let Err(err) = env.call_method(stream, "close", "()V", &[]) {
        let detail = err.to_string();
        let _ = catch_exc(env, "OutputStream.close");
        return Err(format!("关闭 Android 文件写入流失败：{detail}"));
    }
    catch_exc(env, "OutputStream.close")
}

fn write_via_output_stream<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
    bytes: &[u8],
) -> Result<(), String> {
    let stream = open_output_stream(env, resolver, uri)?;
    let write_result = write_bytes_to_stream(env, &stream, bytes);
    let close_result = close_output_stream(env, &stream);
    write_result.and(close_result)
}

fn write_file_via_output_stream<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
    source: &Path,
) -> Result<(), String> {
    let stream = open_output_stream(env, resolver, uri)?;
    let write_result = write_file_to_stream(env, &stream, source);
    let close_result = close_output_stream(env, &stream);
    write_result.and(close_result)
}

fn write_file_to_stream<'a>(
    env: &mut JNIEnv<'a>,
    stream: &JObject<'a>,
    source: &Path,
) -> Result<(), String> {
    let mut file = File::open(source).map_err(|e| format!("打开临时文件失败：{e}"))?;
    let mut buf = vec![0u8; WRITE_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取临时文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        write_bytes_to_stream_part(env, stream, &buf[..n])?;
    }
    Ok(())
}

fn write_bytes_to_stream<'a>(
    env: &mut JNIEnv<'a>,
    stream: &JObject<'a>,
    bytes: &[u8],
) -> Result<(), String> {
    for part in bytes.chunks(WRITE_CHUNK) {
        write_bytes_to_stream_part(env, stream, part)?;
    }
    Ok(())
}

fn write_bytes_to_stream_part<'a>(
    env: &mut JNIEnv<'a>,
    stream: &JObject<'a>,
    part: &[u8],
) -> Result<(), String> {
    let signed: Vec<i8> = part.iter().map(|b| *b as i8).collect();
    let arr = match env.new_byte_array(signed.len() as jsize) {
        Ok(arr) => arr,
        Err(err) => {
            let detail = err.to_string();
            let _ = catch_exc(env, "NewByteArray");
            return Err(format!("创建 Android 写入缓冲区失败：{detail}"));
        }
    };
    if let Err(err) = env.set_byte_array_region(&arr, 0, &signed) {
        let detail = err.to_string();
        let _ = catch_exc(env, "SetByteArrayRegion");
        return Err(format!("准备 Android 写入缓冲区失败：{detail}"));
    }
    let arr_obj: JObject = arr.into();
    if let Err(err) = env.call_method(stream, "write", "([B)V", &[JValue::Object(&arr_obj)]) {
        let detail = err.to_string();
        let _ = catch_exc(env, "OutputStream.write");
        let _ = env.delete_local_ref(arr_obj);
        return Err(format!("写入 Android 文件失败：{detail}"));
    }
    catch_exc(env, "OutputStream.write")?;
    let _ = env.delete_local_ref(arr_obj);
    Ok(())
}
fn cv_put<'a>(
    env: &mut JNIEnv<'a>,
    values: &JObject<'a>,
    key: &str,
    val: &str,
) -> Result<(), String> {
    let k: JObject = env.new_string(key).map_err(|e| e.to_string())?.into();
    let v: JObject = env.new_string(val).map_err(|e| e.to_string())?.into();
    env.call_method(
        values,
        "put",
        // ContentValues 没有 put(String,Object)，必须用具体类型；这里写入的都是字符串
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&k), JValue::Object(&v)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn cv_put_i32<'a>(
    env: &mut JNIEnv<'a>,
    values: &JObject<'a>,
    key: &str,
    val: i32,
) -> Result<(), String> {
    let integer_class = env
        .find_class("java/lang/Integer")
        .map_err(|e| e.to_string())?;
    let boxed = env
        .new_object(&integer_class, "<init>", &[JValue::Int(val)])
        .map_err(|e| e.to_string())?;
    let k: JObject = env.new_string(key).map_err(|e| e.to_string())?.into();
    env.call_method(
        values,
        "put",
        "(Ljava/lang/String;Ljava/lang/Integer;)V",
        &[JValue::Object(&k), JValue::Object(&boxed)],
    )
    .map_err(|e| e.to_string())?;
    catch_exc(env, "ContentValues.put(Integer)")
}

fn publish_media_store_file<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
) -> Result<(), String> {
    let cv_class = env
        .find_class("android/content/ContentValues")
        .map_err(|e| e.to_string())?;
    let values = env
        .new_object(&cv_class, "<init>", &[])
        .map_err(|e| e.to_string())?;
    cv_put_i32(env, &values, MEDIA_IS_PENDING, 0)?;
    let selection = JObject::null();
    let selection_args = JObject::null();
    env.call_method(
        resolver,
        "update",
        "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
        &[
            JValue::Object(uri),
            JValue::Object(&values),
            JValue::Object(&selection),
            JValue::Object(&selection_args),
        ],
    )
    .map_err(|e| e.to_string())?
    .i()
    .map_err(|e| e.to_string())?;
    catch_exc(env, "MediaStore.update")
}

fn delete_uri<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
) -> Result<(), String> {
    // 清掉上一个失败的 Java 调用，确保清理动作本身能执行。
    let _ = env.exception_clear();
    let selection = JObject::null();
    let selection_args = JObject::null();
    env.call_method(
        resolver,
        "delete",
        "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I",
        &[
            JValue::Object(uri),
            JValue::Object(&selection),
            JValue::Object(&selection_args),
        ],
    )
    .map_err(|e| e.to_string())?
    .i()
    .map_err(|e| e.to_string())?;
    catch_exc(env, "ContentResolver.delete")
}

fn content_resolver<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
) -> Result<JObject<'a>, String> {
    env.call_method(
        activity,
        "getContentResolver",
        "()Landroid/content/ContentResolver;",
        &[],
    )
    .map_err(|e| e.to_string())?
    .l()
    .map_err(|e| e.to_string())
}

fn parse_uri<'a>(env: &mut JNIEnv<'a>, s: &str) -> Result<JObject<'a>, String> {
    let cls = env
        .find_class("android/net/Uri")
        .map_err(|e| e.to_string())?;
    let arg: JObject = env.new_string(s).map_err(|e| e.to_string())?.into();
    env.call_static_method(
        &cls,
        "parse",
        "(Ljava/lang/String;)Landroid/net/Uri;",
        &[JValue::Object(&arg)],
    )
    .map_err(|e| e.to_string())?
    .l()
    .map_err(|e| e.to_string())
}

fn object_to_string<'a>(env: &mut JNIEnv<'a>, obj: &JObject<'a>) -> Result<String, String> {
    let s = env
        .call_method(obj, "toString", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let jstr = JString::from(s);
    env.get_string(&jstr)
        .map_err(|e| e.to_string())
        .map(|j| j.to_string_lossy().into_owned())
}

fn sdk_int(env: &mut JNIEnv) -> Result<i32, String> {
    let cls = env
        .find_class("android/os/Build$VERSION")
        .map_err(|e| e.to_string())?;
    env.get_static_field(&cls, "SDK_INT", "I")
        .map_err(|e| e.to_string())?
        .i()
        .map_err(|e| e.to_string())
}

fn catch_exc(env: &mut JNIEnv, where_: &str) -> Result<(), String> {
    if env.exception_check().map_err(|e| e.to_string())? {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        Err(format!("Android 系统接口异常：{where_}"))
    } else {
        Ok(())
    }
}

fn with_env<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut JNIEnv) -> Result<T, String>,
{
    with_env_inner(None, f)
}

fn with_env_logged<F, T>(app: &AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&mut JNIEnv) -> Result<T, String>,
{
    with_env_inner(Some(app), f)
}

fn with_env_inner<F, T>(app: Option<&AppHandle>, f: F) -> Result<T, String>
where
    F: FnOnce(&mut JNIEnv) -> Result<T, String>,
{
    if let Some(app) = app {
        native_log(app, "android.jni.begin");
    }
    let bridge = android_bridge()
        .lock()
        .map_err(|_| "Android Context 桥接锁已损坏".to_string())?
        .clone()
        .ok_or_else(|| "Android Context 尚未由 MainActivity 注册".to_string())?;
    if let Some(app) = app {
        native_log(app, "android.jni.bridge.ok");
        native_log(app, "android.jni.vm.begin");
    }
    let vm = bridge.vm.clone();
    if let Some(app) = app {
        native_log(app, "android.jni.vm.ok");
        native_log(app, "android.jni.attach.begin");
    }
    let mut guard = vm
        .attach_current_thread()
        .map_err(|e| format!("挂载 JVM 线程失败：{e}"))?;
    if let Some(app) = app {
        native_log(app, "android.jni.attach.ok");
        native_log(app, "android.jni.callback.begin");
    }
    let result = f(&mut guard);
    if let Some(app) = app {
        native_log(
            app,
            format!("android.jni.callback.end ok={}", result.is_ok()),
        );
        native_log(app, "android.jni.exception_clear.begin");
    }
    // 线程卸载（detach）前清掉任何残留异常；否则部分系统（含鸿蒙）检测到
    // 未处理的 JNI 异常会直接中止进程（表现为接收完成瞬间闪退）。
    let _ = guard.exception_clear();
    if let Some(app) = app {
        native_log(app, "android.jni.exception_clear.ok");
    }
    result
}

fn current_context<'a>(env: &mut JNIEnv<'a>) -> Result<JObject<'a>, String> {
    let application = android_bridge()
        .lock()
        .map_err(|_| "Android Context 桥接锁已损坏".to_string())?
        .as_ref()
        .map(|bridge| bridge.application.clone())
        .ok_or_else(|| "Android Application Context 尚未注册".to_string())?;
    env.new_local_ref(application.as_obj())
        .map_err(|e| format!("复制 Application Context 失败：{e}"))
}

/// 调用系统文件查看器打开刚保存的文件，避免用户只能手动翻找 Download。
pub fn open_file(uri_str: &str, mime: &str) -> Result<(), String> {
    if !uri_str.starts_with("content://") {
        return Err("该文件没有可供系统打开的 URI，请到 Download 目录查看".to_string());
    }
    with_env(|env| {
        let activity = current_context(env)?;
        let intent_class = env
            .find_class("android/content/Intent")
            .map_err(|e| e.to_string())?;
        let intent = env
            .new_object(&intent_class, "<init>", &[])
            .map_err(|e| e.to_string())?;
        let action: JObject = env
            .new_string("android.intent.action.VIEW")
            .map_err(|e| e.to_string())?
            .into();
        env.call_method(
            &intent,
            "setAction",
            "(Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&action)],
        )
        .map_err(|e| e.to_string())?;
        let uri = parse_uri(env, uri_str)?;
        let mime_obj: JObject = env
            .new_string(if mime.trim().is_empty() {
                "application/octet-stream"
            } else {
                mime
            })
            .map_err(|e| e.to_string())?
            .into();
        env.call_method(
            &intent,
            "setDataAndType",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&uri), JValue::Object(&mime_obj)],
        )
        .map_err(|e| e.to_string())?;
        // FLAG_GRANT_READ_URI_PERMISSION = 1
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            // READ_URI_PERMISSION | ACTIVITY_NEW_TASK；兼容 Application Context。
            &[JValue::Int(0x10000001)],
        )
        .map_err(|e| e.to_string())?;
        env.call_method(
            &activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )
        .map_err(|e| e.to_string())?;
        catch_exc(env, "startActivity")
    })
}

/// 同名文件追加 (n)
fn suffix_name(name: &str, n: usize) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}).{}", &name[..i], n, &name[i + 1..]),
        _ => format!("{name} ({n})"),
    }
}
