// ============================================================
// Android 存储桥（仅在 target_os = "android" 编译）
// 默认目录：MediaStore.Downloads（API 29+，无需 WRITE_EXTERNAL_STORAGE）
// 自定义目录：SAF ACTION_OPEN_DOCUMENT_TREE 返回的 content:// tree URI
// API 28 及以下：Environment 公共 Download 目录（配合 manifest maxSdkVersion=28）
// ============================================================
use jni::objects::*;
use jni::sys::jsize;
use jni::{JNIEnv, JavaVM};

use crate::SavedFile;

const DOWNLOADS_COLLECTION: &str = "content://media/external/downloads";
const WRITE_CHUNK: usize = 4 * 1024 * 1024; // 分块 4MiB 写入，避免一次性巨型数组

// ---------------- 入口 ----------------

pub fn save(dir: &str, name: &str, mime: &str, bytes: &[u8]) -> Result<SavedFile, String> {
    with_env(|env| {
        let activity = current_activity(env)?;
        let sdk = sdk_int(env)?;
        if dir.starts_with("content://") && dir != DOWNLOADS_COLLECTION {
            save_via_saf(env, &activity, dir, name, mime, bytes)
        } else if sdk >= 29 {
            save_via_mediastore(env, &activity, name, mime, bytes)
        } else {
            save_via_external_legacy(env, &activity, name, bytes)
        }
    })
}

/// 对 SAF 目录申请持久化读写授权（应用重启后仍有效）
pub fn persist_tree_uri(uri_str: &str) -> Result<(), String> {
    with_env(|env| {
        let activity = current_activity(env)?;
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

    let cv_class = env.find_class("android/content/ContentValues").map_err(|e| e.to_string())?;
    let values = env
        .new_object(&cv_class, "<init>", &[])
        .map_err(|e| e.to_string())?;
    cv_put(env, &values, "display_name", name)?;
    cv_put(env, &values, "mime_type", mime)?;

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
    write_via_output_stream(env, &resolver, &uri, bytes)?;
    let uri_str = object_to_string(env, &uri)?;
    Ok(SavedFile {
        uri: uri_str,
        display: format!("公共下载目录 Download/{name}"),
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
        let name_obj: JObject = env.new_string(&final_name).map_err(|e| e.to_string())?.into();
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

// ---------------- API 28 及以下兜底：公共 Download ----------------

fn save_via_external_legacy<'a>(
    env: &mut JNIEnv<'a>,
    _activity: &JObject<'a>,
    name: &str,
    bytes: &[u8],
) -> Result<SavedFile, String> {
    let env_class = env.find_class("android/os/Environment").map_err(|e| e.to_string())?;
    let kind: JObject = env.new_string("Download").map_err(|e| e.to_string())?.into();
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

    let fos_class = env.find_class("java/io/FileOutputStream").map_err(|e| e.to_string())?;
    let stream = env
        .new_object(&fos_class, "<init>", &[JValue::Object(&file)])
        .map_err(|e| e.to_string())?;
    catch_exc(env, "FileOutputStream")?;
    write_bytes_to_stream(env, &stream, bytes)?;
    Ok(SavedFile {
        uri: format!("/sdcard/Download/{name}"),
        display: format!("公共下载目录 Download/{name}"),
    })
}

// ---------------- 通用 JNI 工具 ----------------

fn write_via_output_stream<'a>(
    env: &mut JNIEnv<'a>,
    resolver: &JObject<'a>,
    uri: &JObject<'a>,
    bytes: &[u8],
) -> Result<(), String> {
    let mode: JObject = env.new_string("w").map_err(|e| e.to_string())?.into();
    let stream = env
        .call_method(
            resolver,
            "openOutputStream",
            "(Landroid/net/Uri;Ljava/lang/String;)Ljava/io/OutputStream;",
            &[JValue::Object(uri), JValue::Object(&mode)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    catch_exc(env, "openOutputStream")?;
    write_bytes_to_stream(env, &stream, bytes)?;
    Ok(())
}

fn write_bytes_to_stream<'a>(
    env: &mut JNIEnv<'a>,
    stream: &JObject<'a>,
    bytes: &[u8],
) -> Result<(), String> {
    for part in bytes.chunks(WRITE_CHUNK) {
        let signed: Vec<i8> = part.iter().map(|b| *b as i8).collect();
        let arr = env
            .new_byte_array(signed.len() as jsize)
            .map_err(|e| e.to_string())?;
        env.set_byte_array_region(&arr, 0, &signed)
            .map_err(|e| e.to_string())?;
        let arr_obj: JObject = arr.into();
        env.call_method(&stream, "write", "([B)V", &[JValue::Object(&arr_obj)])
            .map_err(|e| e.to_string())?;
        catch_exc(env, "OutputStream.write")?;
        let _ = env.delete_local_ref(arr_obj);
    }
    env.call_method(&stream, "close", "()V", &[])
        .map_err(|e| e.to_string())?;
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
        "(Ljava/lang/String;Ljava/lang/Object;)V",
        &[JValue::Object(&k), JValue::Object(&v)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    let cls = env.find_class("android/net/Uri").map_err(|e| e.to_string())?;
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
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut guard = vm
        .attach_current_thread()
        .map_err(|e| format!("挂载 JVM 线程失败：{e}"))?;
    f(&mut guard)
}

fn current_activity<'a>(_env: &mut JNIEnv<'a>) -> Result<JObject<'a>, String> {
    let ctx = ndk_context::android_context();
    // ndk-context 0.1.x 中 vm/context 为公开裸指针字段
    if ctx.context().is_null() {
        return Err("Android Context 不可用".to_string());
    }
    // from_raw 仅包装裸指针，不创建新的 JNI 引用
    Ok(unsafe { JObject::from_raw(ctx.context().cast()) })
}

/// 同名文件追加 (n)
fn suffix_name(name: &str, n: usize) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}).{}", &name[..i], n, &name[i + 1..]),
        _ => format!("{name} ({n})"),
    }
}
