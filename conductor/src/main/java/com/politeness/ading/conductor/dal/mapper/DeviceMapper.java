package com.politeness.ading.conductor.dal.mapper;

import java.time.LocalDateTime;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** devices: device parameters are stored once and shared by all accounts. Fields the client did not send (old versions) do not overwrite existing values. */
@Mapper
public interface DeviceMapper {

    /** Written on registration (sign-in, launch). Device type keeps the value from the first registration */
    @Insert("""
            INSERT INTO devices (device_uuid, device_type, name, app_version, os_version, first_seen_at, last_active_at)
            VALUES (#{deviceUuid}, #{deviceType}, #{name}, #{appVersion}, #{osVersion}, #{at}, #{at})
            ON DUPLICATE KEY UPDATE
              name = COALESCE(VALUES(name), name),
              app_version = COALESCE(VALUES(app_version), app_version),
              os_version = COALESCE(VALUES(os_version), os_version),
              last_active_at = GREATEST(COALESCE(last_active_at, VALUES(last_active_at)), VALUES(last_active_at))
            """)
    int upsertRegistered(@Param("deviceUuid") String deviceUuid, @Param("deviceType") String deviceType,
                         @Param("name") String name, @Param("appVersion") String appVersion,
                         @Param("osVersion") String osVersion, @Param("at") LocalDateTime at);

    /** Written on telemetry. Standalone mode also goes through here, so the device may not have a name yet; last-active time is not updated here, it only follows the MQTT connection */
    @Insert("""
            INSERT INTO devices (device_uuid, device_type, city, app_version, os_version, first_seen_at)
            VALUES (#{deviceUuid}, #{deviceType}, #{city}, #{appVersion}, #{osVersion}, #{at})
            ON DUPLICATE KEY UPDATE
              device_type = VALUES(device_type),
              city = COALESCE(VALUES(city), city),
              app_version = COALESCE(VALUES(app_version), app_version),
              os_version = COALESCE(VALUES(os_version), os_version)
            """)
    int upsertReported(@Param("deviceUuid") String deviceUuid, @Param("deviceType") String deviceType,
                       @Param("city") String city,
                       @Param("appVersion") String appVersion, @Param("osVersion") String osVersion,
                       @Param("at") LocalDateTime at);

    /** Terminals registered by old backends have no device row yet; fill it in when polled. Leave it alone if it already exists */
    @Insert("""
            INSERT IGNORE INTO devices (device_uuid, device_type, name, first_seen_at)
            VALUES (#{deviceUuid}, #{deviceType}, #{name}, #{at})
            """)
    int insertIfAbsent(@Param("deviceUuid") String deviceUuid, @Param("deviceType") String deviceType,
                       @Param("name") String name, @Param("at") LocalDateTime at);

    @Update("""
            UPDATE devices SET last_active_at = #{at}, gmt_modified = gmt_modified
             WHERE device_uuid = #{deviceUuid} AND (last_active_at IS NULL OR last_active_at < #{at})
            """)
    int touchActive(@Param("deviceUuid") String deviceUuid, @Param("at") LocalDateTime at);

    /** Update checks need no sign-in and requests can be forged anonymously, so only update the version of existing devices; never create devices or count as active */
    @Update("UPDATE devices SET app_version = #{appVersion} WHERE device_uuid = #{deviceUuid}")
    int updateAppVersion(@Param("deviceUuid") String deviceUuid, @Param("appVersion") String appVersion);

    /** Update the city when the registration request's public IP can be resolved; keep the existing value for unknown addresses. */
    @Update("UPDATE devices SET city = #{city} WHERE device_uuid = #{deviceUuid}")
    int updateCity(@Param("deviceUuid") String deviceUuid, @Param("city") String city);

    @Select("SELECT name FROM devices WHERE device_uuid = #{deviceUuid}")
    String findName(@Param("deviceUuid") String deviceUuid);
}
