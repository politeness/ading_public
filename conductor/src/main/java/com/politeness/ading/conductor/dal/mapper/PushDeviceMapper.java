package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface PushDeviceMapper {

    @Insert("""
            INSERT INTO push_devices (terminal_id, owner, device_token, environment, language)
            VALUES (#{terminalId}, #{owner}, #{deviceToken}, #{environment}, #{language})
            ON DUPLICATE KEY UPDATE owner = VALUES(owner), device_token = VALUES(device_token),
                   environment = VALUES(environment), language = VALUES(language)
            """)
    int upsert(PushDeviceEntity device);

    /** Same phone switched accounts: the token stays the same, the terminal changed, and the previous account must no longer receive notifications */
    @Delete("DELETE FROM push_devices WHERE device_token = #{deviceToken} AND terminal_id <> #{terminalId}")
    int deleteOtherHolders(@Param("deviceToken") String deviceToken, @Param("terminalId") String terminalId);

    @Delete("DELETE FROM push_devices WHERE terminal_id = #{terminalId}")
    int deleteByTerminal(@Param("terminalId") String terminalId);

    @Delete("DELETE FROM push_devices WHERE device_token = #{deviceToken}")
    int deleteByToken(@Param("deviceToken") String deviceToken);

    /** After a password change all of this account's earlier terminal tokens are invalid and the phone can no longer unregister itself, so the server cleans them up on its behalf */
    @Delete("DELETE FROM push_devices WHERE owner = #{owner}")
    int deleteByOwner(@Param("owner") String owner);

    /** Do not push to disabled terminals */
    @Select("""
            <script>
            SELECT p.* FROM push_devices p
              JOIN terminals t ON t.terminal_id = p.terminal_id AND t.status &lt;&gt; 'DISABLED'
             WHERE p.owner IN
            <foreach item='id' collection='owners' open='(' separator=',' close=')'>#{id}</foreach>
            </script>
            """)
    List<PushDeviceEntity> listByOwners(@Param("owners") List<String> owners);
}
