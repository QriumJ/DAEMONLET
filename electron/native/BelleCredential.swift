import Foundation
import Security
// One fixed app-owned item. No caller-controlled account/service/path or credential argv.
let service="io.github.ddol2ya.daemonlet.belle-connection"
let account="runtime-v1"
func finish(_ value:[String:Any]) -> Never { if let data=try? JSONSerialization.data(withJSONObject:value){FileHandle.standardOutput.write(data)};exit(0) }
func fail(_ status:OSStatus) -> Never {
 let code=status==errSecItemNotFound ? "KEY_MISSING" : status==errSecUserCanceled || status==errSecAuthFailed ? "STORE_DENIED" : status==errSecInteractionNotAllowed ? "STORE_LOCKED" : "STORE_UNAVAILABLE"
 finish(["ok":false,"code":code])
}
let operation=CommandLine.arguments.count==2 ? CommandLine.arguments[1] : ""
var query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account]
if operation=="available" {
 var keychain:SecKeychain?;let status=SecKeychainCopyDefault(&keychain)
 if status != errSecSuccess {fail(status)}
 var flags:SecKeychainStatus=0;let locked=SecKeychainGetStatus(keychain,&flags)
 if locked != errSecSuccess {fail(locked)}
 finish(["ok":true,"available":flags & kSecUnlockStateStatus != 0])
}
if operation=="has" {
 query[kSecReturnAttributes as String]=true;query[kSecUseAuthenticationUI as String]=kSecUseAuthenticationUIFail
 var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result)
 if status==errSecItemNotFound {finish(["ok":true,"stored":false])};if status != errSecSuccess {fail(status)}
 finish(["ok":true,"stored":true])
}
if operation=="get" {
 query[kSecReturnData as String]=true
 var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result)
 if status != errSecSuccess {fail(status)}
 guard let data=result as? Data,let key=String(data:data,encoding:.utf8),key.utf8.count<=1024 else {finish(["ok":false,"code":"STORE_UNAVAILABLE"])}
 finish(["ok":true,"key":key])
}
if operation=="put" {
 var data=Data()
 while data.count<=2048 {guard let chunk=try? FileHandle.standardInput.read(upToCount:2049-data.count),!chunk.isEmpty else {break};data.append(chunk)}
 guard data.count<=2048,let object=(try? JSONSerialization.jsonObject(with:data)) as? [String:String],object.count==1,let key=object["key"],key.range(of:"^sk-[A-Za-z0-9_-]{20,1020}$",options:.regularExpression) != nil else {finish(["ok":false,"code":"INVALID_KEY"])}
 let attributes:[String:Any]=[kSecValueData as String:Data(key.utf8),kSecAttrLabel as String:"DAEMONLET Belle — restricted tunnel runtime key"]
 var status=SecItemUpdate(query as CFDictionary,attributes as CFDictionary)
 if status==errSecItemNotFound {query.merge(attributes){_,new in new};status=SecItemAdd(query as CFDictionary,nil)}
 if status != errSecSuccess {fail(status)}
 finish(["ok":true])
}
if operation=="remove" {let status=SecItemDelete(query as CFDictionary);if status != errSecSuccess && status != errSecItemNotFound {fail(status)};finish(["ok":true])}
finish(["ok":false,"code":"STORE_UNAVAILABLE"])
